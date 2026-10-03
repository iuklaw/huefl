// Updates from GitHub Releases, through the official tauri-plugin-updater.
//
// The app fetches `latest.json` (version, notes, and per platform a download
// URL with a minisign signature), compares versions, and on the user's word
// downloads and installs:
//   AppImage  the file is replaced in place;
//   .deb/.rpm installed with pkexec (the system's password prompt; the plugin
//             falls back to zenity / kdialog).
// The signature is checked against the public key built into the app
// (tauri.conf.json → plugins.updater.pubkey): a file that wasn't signed with
// the release key is refused, wherever it came from.
//
// Off while the key or the address isn't set yet, and in development builds.
// HUEFL_UPDATE_ENDPOINT overrides the address (for testing a release locally;
// the signature is still required).

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::logs;

/// The update found by the last check, kept for `update_install`.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
    /// RFC 3339
    date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Whether this build can update itself: a public key and somewhere to look.
fn configured(app: &AppHandle) -> bool {
    let config = app.config().plugins.0.get("updater");
    let has = |key: &str| {
        config.and_then(|c| c.get(key)).is_some_and(|v| match v {
            serde_json::Value::String(s) => !s.is_empty(),
            serde_json::Value::Array(a) => !a.is_empty(),
            _ => false,
        })
    };
    let endpoint = has("endpoints") || override_endpoint().is_some();
    has("pubkey") && endpoint && (!cfg!(debug_assertions) || override_endpoint().is_some())
}

fn override_endpoint() -> Option<tauri::Url> {
    std::env::var("HUEFL_UPDATE_ENDPOINT").ok().and_then(|u| u.parse().ok())
}

/// Looks for a newer version. `Ok(None)`: up to date; `Err("not_configured")`:
/// this build has no release key or address yet.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    if !configured(&app) {
        return Err("not_configured".into());
    }
    let mut builder = app.updater_builder();
    if let Some(endpoint) = override_endpoint() {
        builder = builder.endpoints(vec![endpoint]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| {
        logs::write(&app, "debug", "app", "update.failed", format!("Update check failed: {e}"), None);
        e.to_string()
    })?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.and_then(|d| d.format(&time::format_description::well_known::Rfc3339).ok()),
    });
    match &info {
        Some(i) => logs::write(&app, "info", "app", "update.available", format!("Version {} is available", i.version), None),
        None => logs::write(&app, "debug", "app", "update.checked", "Up to date", None),
    }
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// Downloads and installs the update found by `update_check`, reporting
/// progress. The app keeps running; `update_restart` switches over.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update to install - check again.")?;
    let version = update.version.clone();
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_progress.send(Progress { downloaded, total });
            },
            || {},
        )
        .await;
    match result {
        Ok(()) => {
            logs::write(&app, "info", "app", "update.downloaded", format!("Version {version} installed; restart to use it"), None);
            Ok(())
        }
        Err(e) => {
            logs::write(&app, "warn", "app", "update.failed", format!("Installing {version} failed: {e}"), None);
            Err(e.to_string())
        }
    }
}

/// Restarts into the new version - after ending a running sync, so the
/// lights are given back first.
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    crate::sync::shutdown(&app);
    app.restart();
}

pub fn init(app: &AppHandle) {
    app.manage(PendingUpdate::default());
}
