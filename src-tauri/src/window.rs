// Hiding to the tray and showing again, without losing the window's place.
//
// On Linux the window manager places a re-shown window from scratch, so the
// position is remembered on hide and restored on show. The size survives on
// its own. Session-only by design: after a restart the WM decides.
// (Wayland does not let apps position windows; there this is a no-op.)
//
// Every hide/show goes through here - the UI's "Minimize to tray" and the
// tray's "Show window" - so the position is recorded in one place.

use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

use crate::logs;

#[derive(Default)]
pub struct WindowPlacement(Mutex<Option<PhysicalPosition<i32>>>);

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn hide(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    let position = window.outer_position().ok();
    if let Some(position) = position {
        *app.state::<WindowPlacement>().0.lock().unwrap() = Some(position);
    }
    let _ = window.hide();
    logs::write(
        app,
        "info",
        "app",
        "window.hidden",
        "Window hidden to the tray",
        Some(json!({ "position": position.map(|p| [p.x, p.y]) })),
    );
}

pub fn show(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    let was_visible = window.is_visible().unwrap_or(false);

    // Only a window coming back from the tray gets its old place. An open
    // window stays where the user moved it - it is just brought forward.
    let restored = if was_visible {
        None
    } else {
        let saved = app.state::<WindowPlacement>().0.lock().unwrap().take();
        let _ = window.show();
        // After show(): GTK places the window when it gets mapped, overriding
        // anything set before.
        if let Some(position) = saved {
            let _ = window.set_position(position);
        }
        saved
    };

    let _ = window.unminimize();
    // GNOME's focus-stealing prevention may turn a plain set_focus() into an
    // "is ready" notification; briefly going always-on-top raises the window.
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    let _ = window.set_always_on_top(false);

    logs::write(
        app,
        "info",
        "app",
        "window.shown",
        if was_visible { "Window brought to front" } else { "Window shown" },
        Some(json!({ "wasVisible": was_visible, "restoredPosition": restored.map(|p| [p.x, p.y]) })),
    );
}

#[tauri::command]
pub fn window_hide(app: AppHandle) {
    hide(&app);
}

#[tauri::command]
pub fn window_show(app: AppHandle) {
    show(&app);
}
