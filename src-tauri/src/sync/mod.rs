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
pub mod screen;
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
    /// False without `sync-screen`, on Wayland, or without a display.
    screen_supported: bool,
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
    if cfg!(debug_assertions) && std::env::var_os("HUEFL_DEV_HIDE_AREAS").is_some() {
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
        screen: Some(screen::capture::unavailable_reason()),
    });
    Ok(SyncOverview {
        ready: readiness::is_ready(&checks),
        checks,
        areas,
        lights,
        status,
        audio_supported: cfg!(feature = "sync-audio"),
        screen_supported: screen::capture::unavailable_reason().is_none(),
    })
}

/// Current default output / input labels for "Sound from"; cheap, no bridge.
#[tauri::command]
pub fn sync_audio_devices(app: AppHandle) -> Result<AudioDevices, AudioProblem> {
    let devices = audio::devices::default_devices();
    logs::write(&app, "debug", "app", "sync.audio_devices", format!("{devices:?}"), None);
    devices
}

/// Monitors for screen sync (RandR names, sizes, which is primary).
#[tauri::command]
pub fn sync_monitors() -> Result<Vec<screen::capture::Monitor>, String> {
    screen::capture::monitors()
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
            screen: Some(screen::capture::unavailable_reason()),
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

    /// Live: the whole screen path on real lights for 5 s (screen → effect →
    /// DTLS), then the lights are restored. Prints packets/s and CPU time.
    /// Run: `cargo test --lib live_stream_screen -- --ignored --nocapture`
    #[cfg(feature = "sync-screen")]
    #[tokio::test]
    #[ignore]
    async fn live_stream_screen() {
        use std::sync::atomic::AtomicBool;
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        use effects::{Effect, ScreenEffect};
        use entertainment::dtls::DtlsStream;
        use entertainment::protocol::{encode, ChannelColor, ColorSpace};
        use screen::capture::ScreenSource;

        let hue = HueState::default();
        let (access, client_key) = manager::bridge_access().unwrap();
        let area = access.areas(&hue).await.unwrap().into_iter().next().expect("an area");
        let saved = access.light_snapshot(&hue, &area.light_ids).await.unwrap();

        let grid = Arc::new(Mutex::new(None));
        let lost = Arc::new(AtomicBool::new(false));
        let source = ScreenSource::start(None, grid.clone(), lost.clone(), Box::new(|e| println!("screen: {e:?}"))).unwrap();
        let mut effect = ScreenEffect::new(1, true, grid, lost);

        access.set_streaming(&hue, &area.id, true).await.unwrap();
        let cpu_before = cpu_seconds();
        let (sent, last) = tokio::task::spawn_blocking({
            let (ip, key, area) = (access.ip.clone(), access.key.clone(), area.clone());
            move || {
                let mut stream = DtlsStream::connect(&ip, &key, &client_key.unwrap()).unwrap();
                let begin = Instant::now();
                let (mut sent, mut last) = (0u32, vec![]);
                while begin.elapsed() < Duration::from_secs(5) {
                    last = effect.render(0.02, &area.channels);
                    let channels: Vec<_> = area.channels.iter().zip(&last).map(|(c, rgb)| ChannelColor::rgb(c.channel_id, rgb[0], rgb[1], rgb[2])).collect();
                    stream.send(&encode(sent as u8, &area.id, ColorSpace::Rgb, &channels).unwrap()).unwrap();
                    sent += 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                stream.close();
                (sent, last)
            }
        })
        .await
        .unwrap();
        let cpu = cpu_seconds() - cpu_before;
        drop(source);

        access.set_streaming(&hue, &area.id, false).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        access.restore_lights(&hue, &saved).await.unwrap();

        println!("sent {sent} packets ({:.0}/s), CPU {:.0}% of one core, last colors {last:?}", sent as f32 / 5.0, cpu / 5.0 * 100.0);
        assert!(sent > 150);
    }

    /// This process's user + system CPU time, seconds.
    fn cpu_seconds() -> f64 {
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
        let fields: Vec<&str> = stat.rsplit(')').next().unwrap().split_whitespace().collect();
        let ticks: f64 = fields[11].parse::<f64>().unwrap() + fields[12].parse::<f64>().unwrap();
        ticks / 100.0
    }
}
