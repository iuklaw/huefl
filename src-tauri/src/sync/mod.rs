// Light sync with sound and screen, via the Hue Entertainment API.
//
// The whole engine runs in Rust: WebKitGTK suspends JS in a hidden window,
// and sync must keep going while the app sits in the tray. The UI only sends
// commands and listens to "sync-status" / "sync-preview".
//
//   entertainment/  REST (areas, start/stop), packet format, DTLS
//   readiness.rs    what sync needs, as a checklist
//   effects.rs      what the lights show
//   manager.rs      one session at a time: state machine + cleanup

pub mod audio;
pub mod effects;
pub mod entertainment;
pub mod manager;
pub mod readiness;
pub mod smoothing;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::hue::HueState;
use crate::logs;
use audio::devices::{AudioDevices, AudioProblem};
use entertainment::api::{Area, AreaDraft, SyncLight};
use manager::{SyncManager, SyncRequest, SyncStatus};
use readiness::{Check, Facts};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOverview {
    checks: Vec<Check>,
    ready: bool,
    areas: Vec<Area>,
    lights: Vec<SyncLight>,
    status: SyncStatus,
    /// False in builds without the `sync-audio` feature: music mode is off.
    audio_supported: bool,
}

/// Everything the Sync tab needs in one call: checklist, areas, lights, status.
#[tauri::command]
pub async fn sync_overview(
    hue: State<'_, HueState>,
    manager: State<'_, SyncManager>,
) -> Result<SyncOverview, String> {
    let (access, client_key) = manager::bridge_access()?;
    let (model, api_version) = access.bridge_facts(&hue).await.unwrap_or((None, None));
    let lights = access.sync_lights(&hue).await?;
    let mut areas = access.areas(&hue).await?;
    // Development aid: see the "no sync area" checklist on a bridge that has one.
    if cfg!(debug_assertions) && std::env::var_os("HUE_TRAY_DEV_HIDE_AREAS").is_some() {
        areas.clear();
    }

    let audio = audio::devices::default_devices();
    let status = manager.status();
    let ours = match &status {
        SyncStatus::Starting { area_id } | SyncStatus::Streaming { area_id, .. } => Some(area_id.as_str()),
        _ => None,
    };
    let busy_area = areas
        .iter()
        .find(|a| a.status == "active" && Some(a.id.as_str()) != ours)
        .map(|a| a.name.clone());

    let checks = readiness::evaluate(&Facts {
        bridge_model: model.as_deref(),
        api_version: api_version.as_deref(),
        has_client_key: client_key.is_some(),
        stream_lights: lights.iter().filter(|l| l.renderer).count(),
        areas: &areas,
        busy_area: busy_area.as_deref(),
        audio: Some(&audio),
    });
    Ok(SyncOverview {
        ready: readiness::is_ready(&checks),
        checks,
        areas,
        lights,
        status,
        audio_supported: cfg!(feature = "sync-audio"),
    })
}

/// Current default output / input labels for "Sound from"; cheap, no bridge.
#[tauri::command]
pub fn sync_audio_devices(app: AppHandle) -> Result<AudioDevices, AudioProblem> {
    let devices = audio::devices::default_devices();
    logs::write(&app, "debug", "app", "sync.audio_devices", format!("{devices:?}"), None);
    devices
}

#[tauri::command]
pub async fn sync_start(app: AppHandle, request: SyncRequest) -> Result<(), String> {
    manager::start(&app, request).await
}

#[tauri::command]
pub async fn sync_stop(app: AppHandle) {
    manager::stop(&app).await;
}

#[tauri::command]
pub fn sync_status(manager: State<'_, SyncManager>) -> SyncStatus {
    manager.status()
}

#[tauri::command]
pub async fn sync_create_area(app: AppHandle, hue: State<'_, HueState>, draft: AreaDraft) -> Result<String, String> {
    let (access, _) = manager::bridge_access()?;
    let id = access.create_area(&hue, &draft).await?;
    logs::write(&app, "info", "app", "sync.area_created", format!("Sync area “{}” created", draft.name),
        Some(json!({ "kind": draft.kind, "lights": draft.members.len() })));
    Ok(id)
}

#[tauri::command]
pub async fn sync_update_area(app: AppHandle, hue: State<'_, HueState>, id: String, draft: AreaDraft) -> Result<(), String> {
    let (access, _) = manager::bridge_access()?;
    access.update_area(&hue, &id, &draft).await?;
    logs::write(&app, "info", "app", "sync.area_updated", format!("Sync area “{}” updated", draft.name), None);
    Ok(())
}

#[tauri::command]
pub async fn sync_delete_area(app: AppHandle, hue: State<'_, HueState>, id: String) -> Result<(), String> {
    let (access, _) = manager::bridge_access()?;
    access.delete_area(&hue, &id).await?;
    logs::write(&app, "info", "app", "sync.area_deleted", "Sync area deleted", Some(json!({ "id": id })));
    Ok(())
}

/// On quit: end the stream and give the lights back before the process exits.
pub fn shutdown(app: &AppHandle) {
    tauri::async_runtime::block_on(manager::stop(app));
}

/// Live, read-only check of what the Sync tab shows for the real bridge.
/// Run: `cargo test --lib live_overview -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_overview() {
        let hue = HueState::default();
        let (access, client_key) = manager::bridge_access().unwrap();
        let (model, api) = access.bridge_facts(&hue).await.unwrap();
        let lights = access.sync_lights(&hue).await.unwrap();
        let areas = access.areas(&hue).await.unwrap();
        let checks = readiness::evaluate(&Facts {
            bridge_model: model.as_deref(),
            api_version: api.as_deref(),
            has_client_key: client_key.is_some(),
            stream_lights: lights.iter().filter(|l| l.renderer).count(),
            areas: &areas,
            busy_area: None,
            audio: Some(&audio::devices::default_devices()),
        });
        println!("bridge {model:?} api {api:?}");
        for c in &checks {
            println!("  {:?} {} {:?}", c.level, c.id, c.params);
        }
        for a in &areas {
            println!("area {} ({}) members {:?}", a.name, a.kind, a.members.iter().map(|m| (&m.service_id[..8], m.position.x)).collect::<Vec<_>>());
        }
        println!("lights {:?}", lights.iter().map(|l| (&l.light_id[..8], l.renderer)).collect::<Vec<_>>());
        assert!(readiness::is_ready(&checks));
    }
}
