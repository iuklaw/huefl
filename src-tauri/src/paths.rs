// Where HueFL keeps its files (XDG), and moving them over from the app's old
// name ("hue-tray") - so a renamed install keeps its pairing, presets and
// logs instead of starting from scratch.
//
//   config  $XDG_CONFIG_HOME/huefl/config.json      (was …/hue-tray/)
//   state   $XDG_STATE_HOME/huefl/huefl.log         (was …/hue-tray/hue-tray.log)

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const APP_DIR: &str = "huefl";
const LEGACY_DIR: &str = "hue-tray";
const LEGACY_LOG: &str = "hue-tray.log";
pub const LOG_FILE: &str = "huefl.log";

fn xdg(var: &str, fallback: &[&str]) -> PathBuf {
    std::env::var(var)
        .ok()
        .filter(|p| p.starts_with('/'))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()));
            fallback.iter().fold(home, |path, part| path.join(part))
        })
}

fn config_base() -> PathBuf {
    xdg("XDG_CONFIG_HOME", &[".config"])
}

fn state_base() -> PathBuf {
    xdg("XDG_STATE_HOME", &[".local", "state"])
}

pub fn config_dir() -> PathBuf {
    config_base().join(APP_DIR)
}

pub fn state_dir() -> PathBuf {
    state_base().join(APP_DIR)
}

/// Moves `old` to `new` when only the old one exists. Returns whether it did.
/// A rename keeps the files' modes (the config holds the bridge key: 600).
pub fn migrate_dir(old: &Path, new: &Path) -> io::Result<bool> {
    if new.exists() || !old.is_dir() {
        return Ok(false);
    }
    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(old, new)?;
    Ok(true)
}

/// Log files carry the app's name too: hue-tray.log(.1) → huefl.log(.1).
fn rename_logs(dir: &Path) -> io::Result<()> {
    for suffix in ["", ".1"] {
        let old = dir.join(format!("{LEGACY_LOG}{suffix}"));
        let new = dir.join(format!("{LOG_FILE}{suffix}"));
        if old.exists() && !new.exists() {
            fs::rename(old, new)?;
        }
    }
    Ok(())
}

/// Brings the old name's config and state over, once. Runs before anything
/// reads them; returns what was moved, for the log.
pub fn migrate_legacy() -> Vec<String> {
    let mut moved = Vec::new();
    let config = (config_base().join(LEGACY_DIR), config_dir());
    if migrate_dir(&config.0, &config.1).unwrap_or(false) {
        moved.push(config.1.display().to_string());
    }
    let state = (state_base().join(LEGACY_DIR), state_dir());
    if migrate_dir(&state.0, &state.1).unwrap_or(false) {
        moved.push(state.1.display().to_string());
    }
    let _ = rename_logs(&state_dir());
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("huefl-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn moves_the_old_directory_once() {
        let base = scratch("move");
        let (old, new) = (base.join("hue-tray"), base.join("huefl"));
        fs::create_dir(&old).unwrap();
        fs::write(old.join("config.json"), "{}").unwrap();

        assert!(migrate_dir(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "{}");
        assert!(!old.exists());
        // Second run: nothing left to move.
        assert!(!migrate_dir(&old, &new).unwrap());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn never_overwrites_the_new_directory() {
        let base = scratch("keep");
        let (old, new) = (base.join("hue-tray"), base.join("huefl"));
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();
        fs::write(new.join("config.json"), "new").unwrap();

        assert!(!migrate_dir(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "new");
        assert!(old.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn log_files_take_the_new_name() {
        let dir = scratch("logs");
        fs::write(dir.join("hue-tray.log"), "a").unwrap();
        fs::write(dir.join("hue-tray.log.1"), "b").unwrap();
        rename_logs(&dir).unwrap();
        assert_eq!(fs::read_to_string(dir.join("huefl.log")).unwrap(), "a");
        assert_eq!(fs::read_to_string(dir.join("huefl.log.1")).unwrap(), "b");
        fs::remove_dir_all(dir).unwrap();
    }
}
