// The system tray icon and its menu.
//
// Owned by Rust on purpose: WebKitGTK suspends JS in a hidden window, so a
// tray whose menu callbacks go through the webview stops responding as soon as
// the app is hidden — which is exactly when a tray app gets used. Here every
// menu action is handled natively, including sending commands to the bridge.
//
// The UI still owns the Hue state and pushes the part the menu needs through
// `set_tray_state`. While the window is hidden and JS is suspended, changes
// made elsewhere (the Philips app, a wall switch) reach the menu only once the
// window is shown again; actions taken from the tray itself are always applied.
//
// Linux note: the tray goes through Ayatana AppIndicator, which does NOT report
// clicks on the icon itself — only menu actions. That is why the menu is set
// when the icon is created and restoring the window is a menu item, not a left
// click.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use crate::config;
use crate::hue::{self, HueState};
use crate::i18n::{t, t_with};
use crate::logs;
use crate::sync::manager::{self as sync, SyncManager, SyncRequest};
use crate::window;
use serde_json::json;

const TRAY_ID: &str = "main";
const ICON_ON: &[u8] = include_bytes!("../../public/tray-on.png");
const ICON_OFF: &[u8] = include_bytes!("../../public/tray-off.png");

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Starting,
    Unconfigured,
    Connecting,
    Ready,
    Error,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayRoom {
    id: String,
    name: String,
    on: bool,
    grouped_light_id: Option<String>,
}

/// What the menu is built from — mirrors `syncTray()` in src/main.ts.
#[derive(Clone, PartialEq, Deserialize, Default)]
pub struct TrayModel {
    status: Status,
    error: Option<String>,
    rooms: Vec<TrayRoom>,
}

#[derive(Default)]
pub struct TrayState(Mutex<TrayModel>);

/// Sent to the UI after a tray action, so its state matches what we sent.
#[derive(Clone, Serialize)]
struct RoomChanged {
    id: String,
    on: bool,
}

// --- Setup -------------------------------------------------------------------

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    app.manage(TrayState::default());

    // The menu must exist from the start — an AppIndicator requirement.
    let menu = build_menu(app, &TrayModel::default())?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON_OFF)?)
        .tooltip("Hue")
        .menu(&menu)
        .on_menu_event(on_menu_event)
        .build(app)?;
    Ok(())
}

// --- Menu --------------------------------------------------------------------

fn build_menu(app: &AppHandle, model: &TrayModel) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;

    let status_text = match model.status {
        Status::Starting => Some(t("tray.starting")),
        Status::Unconfigured => Some(t("tray.status.unconfigured")),
        Status::Connecting => Some(t("tray.status.connecting")),
        Status::Error => Some(t_with(
            "tray.status.error",
            &[("error", &truncate(model.error.as_deref().unwrap_or(""), 40))],
        )),
        Status::Ready if model.rooms.is_empty() => Some(t("tray.status.no_rooms")),
        Status::Ready => None,
    };

    if let Some(text) = status_text {
        menu.append(&MenuItem::with_id(app, "status", text, false, None::<&str>)?)?;
    } else {
        for room in &model.rooms {
            let item = CheckMenuItem::with_id(
                app,
                format!("room:{}", room.id),
                &room.name,
                true,
                room.on,
                None::<&str>,
            )?;
            menu.append(&item)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(app, "all:on", t("tray.all_on"), true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "all:off", t("tray.all_off"), true, None::<&str>)?)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    // Sync runs in Rust, so this works with the window hidden.
    let syncing = app.state::<SyncManager>().is_active();
    let sync_label = if syncing { t("tray.sync_stop") } else { t("tray.sync_start") };
    menu.append(&MenuItem::with_id(app, "sync:toggle", sync_label, true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "window:show", t("tray.show_window"), true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "window:options", t("tray.options"), true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "app:quit", t("tray.quit"), true, None::<&str>)?)?;
    Ok(menu)
}

/// Rebuilds the menu from the current model — e.g. when sync starts or stops.
pub fn refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<TrayState>() else { return };
    let model = state.0.lock().unwrap().clone();
    if let Err(error) = rebuild(app, &model) {
        logs::write(app, "error", "tray", "tray.menu_failed", format!("Menu rebuild failed: {error}"), None);
    }
}

fn rebuild(app: &AppHandle, model: &TrayModel) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_menu(Some(build_menu(app, model)?))?;
    let any_on = model.rooms.iter().any(|r| r.on);
    tray.set_icon(Some(Image::from_bytes(if any_on { ICON_ON } else { ICON_OFF })?))?;
    Ok(())
}

/// Called by the UI on every state publish; the menu is rebuilt only when
/// something it shows has changed (a slider publishes many times a second).
#[tauri::command]
pub fn set_tray_state(app: AppHandle, state: State<'_, TrayState>, model: TrayModel) -> Result<(), String> {
    {
        let mut current = state.0.lock().unwrap();
        if *current == model {
            return Ok(());
        }
        *current = model.clone();
    }
    // Rebuild without holding the lock: menu calls hop to the main thread,
    // which may itself be waiting for the lock in `on_menu_event`.
    rebuild(&app, &model).map_err(|e| e.to_string())
}

// --- Actions -----------------------------------------------------------------

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let action = event.id().as_ref();
    logs::write(app, "info", "tray", "tray.action", format!("Tray menu: {action}"), Some(json!({ "action": action })));
    match action {
        "window:show" => show_window(app),
        "sync:toggle" => toggle_sync(app),
        "window:options" => {
            show_window(app);
            let _ = app.emit("open-options", ());
        }
        "app:quit" => app.exit(0),
        "all:on" | "all:off" => {
            let on = action == "all:on";
            let ids = rooms(app).into_iter().map(|r| (r.id, on)).collect();
            set_rooms(app, ids);
        }
        _ => {
            if let Some(id) = action.strip_prefix("room:") {
                if let Some(room) = rooms(app).into_iter().find(|r| r.id == id) {
                    set_rooms(app, vec![(room.id, !room.on)]);
                }
            }
        }
    }
}

/// Stop a running sync, or repeat the last one; with no previous sync there
/// is nothing to repeat, so the Sync tab opens instead.
fn toggle_sync(app: &AppHandle) {
    let manager = app.state::<SyncManager>();
    if manager.is_active() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { sync::stop(&app).await });
    } else if let Some(request) = manager.last_request() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = sync::start(&app, SyncRequest { take_over: false, ..request }).await;
        });
    } else {
        show_window(app);
        let _ = app.emit("open-sync", ());
    }
}

fn show_window(app: &AppHandle) {
    window::show(app);
}

fn rooms(app: &AppHandle) -> Vec<TrayRoom> {
    app.state::<TrayState>().0.lock().unwrap().rooms.clone()
}

/// Turns rooms on/off: optimistic menu update, UI notification, then one PUT
/// per room's grouped_light straight to the bridge — no JS involved.
fn set_rooms(app: &AppHandle, changes: Vec<(String, bool)>) {
    let Some(settings) = config::read_bridge_settings() else {
        logs::write(app, "warn", "tray", "tray.no_bridge", "Tray action ignored: no bridge settings", None);
        return;
    };
    let (Some(ip), Some(key)) = (settings.bridge_ip, settings.application_key) else {
        logs::write(app, "warn", "tray", "tray.no_bridge", "Tray action ignored: bridge not paired", None);
        return;
    };

    let mut targets = Vec::new();
    let model = {
        let state = app.state::<TrayState>();
        let mut model = state.0.lock().unwrap();
        for (id, on) in &changes {
            if let Some(room) = model.rooms.iter_mut().find(|r| &r.id == id) {
                room.on = *on;
                if let Some(grouped) = &room.grouped_light_id {
                    targets.push((grouped.clone(), *on, room.name.clone()));
                }
            }
        }
        model.clone()
    };
    if let Err(error) = rebuild(app, &model) {
        logs::write(app, "error", "tray", "tray.menu_failed", format!("Menu rebuild failed: {error}"), None);
    }

    for (id, on) in changes {
        let _ = app.emit("tray-room-changed", RoomChanged { id, on });
    }

    let app = app.clone();
    let pin = settings.cert_fingerprint;
    tauri::async_runtime::spawn(async move {
        let state = app.state::<HueState>();
        for (grouped_light_id, on, room) in targets {
            let started = std::time::Instant::now();
            let details = json!({ "room": room, "groupedLightId": grouped_light_id, "on": on });
            let headers = HashMap::from([
                ("hue-application-key".to_string(), key.clone()),
                ("content-type".to_string(), "application/json".to_string()),
            ]);
            let body = serde_json::json!({ "on": { "on": on } }).to_string();
            let path = format!("/clip/v2/resource/grouped_light/{grouped_light_id}");
            match hue::send_request(&state, &ip, "PUT", &path, headers, Some(body), pin.clone()).await {
                Ok(res) if res.status >= 400 => logs::write(
                    &app,
                    "error",
                    "tray",
                    "tray.command_failed",
                    format!("{room}: bridge rejected command (HTTP {})", res.status),
                    Some(json!({ "target": details, "status": res.status, "body": res.body })),
                ),
                Ok(res) => logs::write(
                    &app,
                    "debug",
                    "tray",
                    "command.sent",
                    format!("{room}: {}", if on { "on" } else { "off" }),
                    Some(json!({ "target": details, "status": res.status, "ms": started.elapsed().as_millis() as u64 })),
                ),
                Err(error) => logs::write(
                    &app,
                    "error",
                    "tray",
                    "tray.command_failed",
                    format!("{room}: {error}"),
                    Some(json!({ "target": details })),
                ),
            }
        }
    });
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        format!("{}...", text.chars().take(max - 1).collect::<String>())
    } else {
        text.to_string()
    }
}
