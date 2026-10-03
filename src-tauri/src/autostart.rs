// Starting HueFL when the user logs in.
//
//   outside a Flatpak  an XDG Autostart entry, ~/.config/autostart/huefl.desktop
//                      (the name the README once told people to create by hand,
//                      so such a file shows up as "on")
//   in a Flatpak       the Background portal - a sandboxed app can't write
//                      there; the portal does it, and may ask the user first
//
// The window opens as on any start.

use std::path::Path;

use ashpd::desktop::background::Background;
use serde_json::json;
use tauri::AppHandle;

use crate::logs;
use crate::paths;
use crate::updates::{self, UpdateChannel};

fn in_flatpak() -> bool {
    updates::channel() == UpdateChannel::Flathub
}

/// Whether HueFL starts at login, or None where that can't be read (in a
/// Flatpak the portal only takes requests; the UI keeps the last answer).
#[tauri::command]
pub fn autostart_enabled() -> Option<bool> {
    (!in_flatpak()).then(|| paths::autostart_file().exists())
}

/// Turns starting at login on or off. Returns the resulting state - in a
/// Flatpak the user may decline the portal's request.
#[tauri::command]
pub async fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let (result, method) = if in_flatpak() {
        (set_with_portal(enabled).await, "portal")
    } else {
        (set_with_file(enabled), "file")
    };
    match &result {
        Ok(state) => logs::write(
            &app,
            "info",
            "app",
            "app.autostart",
            format!("Start at login {}", if *state { "on" } else { "off" }),
            Some(json!({ "requested": enabled, "method": method })),
        ),
        Err(e) => logs::write(&app, "warn", "app", "app.autostart_failed", e.clone(), Some(json!({ "method": method }))),
    }
    result
}

async fn set_with_portal(enabled: bool) -> Result<bool, String> {
    let response = Background::request()
        .reason("Start HueFL when you log in")
        .auto_start(enabled)
        .command(["huefl"])
        .dbus_activatable(false)
        .send()
        .await
        .and_then(|request| request.response())
        .map_err(|e| format!("Background portal: {e}"))?;
    Ok(response.auto_start())
}

fn set_with_file(enabled: bool) -> Result<bool, String> {
    let file = paths::autostart_file();
    if !enabled {
        return match std::fs::remove_file(&file) {
            Ok(()) => Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("{}: {e}", file.display())),
        };
    }
    // An AppImage runs from a temporary mount; the file itself is what to start.
    let program = match std::env::var_os("APPIMAGE") {
        Some(appimage) => appimage.into(),
        None => std::env::current_exe().map_err(|e| e.to_string())?,
    };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(&file, desktop_entry(&program)).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(true)
}

fn desktop_entry(program: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=HueFL\n\
         Comment=Light control and sync for Philips Hue\n\
         Exec={}\n\
         Icon=huefl\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n",
        exec_line(program)
    )
}

/// The program as a quoted `Exec` argument: the desktop entry spec wants `"`,
/// `` ` ``, `$` and `\` escaped inside quotes - and the file format then
/// doubles each backslash once more. `%` starts a field code, so it doubles.
fn exec_line(program: &Path) -> String {
    let mut quoted = String::from("\"");
    for c in program.to_string_lossy().chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    quoted.replace('\\', "\\\\").replace('%', "%%")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_path_is_just_quoted() {
        assert_eq!(exec_line(Path::new("/usr/bin/huefl")), "\"/usr/bin/huefl\"");
    }

    #[test]
    fn spaces_survive_and_special_characters_are_escaped() {
        assert_eq!(exec_line(Path::new("/home/a b/HueFL.AppImage")), "\"/home/a b/HueFL.AppImage\"");
        // Quote and dollar: one backslash from quoting, doubled by the format.
        assert_eq!(exec_line(Path::new("/x/\"q\"$y")), "\"/x/\\\\\"q\\\\\"\\\\$y\"");
        assert_eq!(exec_line(Path::new("/x/100%")), "\"/x/100%%\"");
    }

    #[test]
    fn the_entry_starts_huefl() {
        let entry = desktop_entry(Path::new("/opt/HueFL.AppImage"));
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("\nName=HueFL\n"));
        assert!(entry.contains("\nExec=\"/opt/HueFL.AppImage\"\n"));
    }
}
