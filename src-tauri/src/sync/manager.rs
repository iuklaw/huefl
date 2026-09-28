// Runs one sync session at a time: an explicit state machine
//
//   Idle ──start──▶ Starting ──connected──▶ Streaming ──stop / error──▶ Stopping ──▶ Idle | Error
//
// A session is a stream thread (DTLS, 50 Hz) plus a supervisor task that owns
// its whole lifetime: however the thread ends — stopped by the user, the app
// quitting, or the bridge dropping the stream — the supervisor is the single
// cleanup path (stop the area, restore the lights, publish the final state).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

use super::effects::{self, Effect, PaletteCycle};
use super::entertainment::api::{Area, BridgeAccess};
use super::entertainment::dtls::DtlsStream;
use super::entertainment::protocol::{encode, ChannelColor, ColorSpace};
use crate::hue::HueState;
use crate::logs;

const FRAME: Duration = Duration::from_millis(20); // 50 Hz, what the bridge expects
const PREVIEW_EVERY: u32 = 4; // ~12 Hz of preview events for the UI

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum SyncStatus {
    Idle,
    Starting { area_id: String },
    Streaming { area_id: String, light_ids: Vec<String> },
    Stopping,
    Error { code: String, message: String },
}

/// What the UI (or the tray, repeating the last one) asks to run.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub area_id: String,
    /// "test" for now; "music" and "screen" come with their stages.
    pub mode: String,
    /// "#RRGGBB" colors
    pub palette: Vec<String>,
    /// 0 subtle … 3 extreme
    pub intensity: u8,
    /// Put the lights back as they were after stopping.
    pub restore: bool,
    /// Stop another app's stream on this bridge first.
    #[serde(default)]
    pub take_over: bool,
}

struct Session {
    stop: Arc<AtomicBool>,
    supervisor: JoinHandle<()>,
}

#[derive(Default)]
pub struct SyncManager {
    status: Mutex<Option<SyncStatus>>,
    /// Serializes start/stop; held across awaits, hence the async mutex.
    session: tokio::sync::Mutex<Option<Session>>,
    last_request: Mutex<Option<SyncRequest>>,
}

impl SyncManager {
    pub fn status(&self) -> SyncStatus {
        self.status.lock().unwrap().clone().unwrap_or(SyncStatus::Idle)
    }

    pub fn is_active(&self) -> bool {
        matches!(self.status(), SyncStatus::Starting { .. } | SyncStatus::Streaming { .. })
    }

    pub fn last_request(&self) -> Option<SyncRequest> {
        self.last_request.lock().unwrap().clone()
    }
}

fn set_status(app: &AppHandle, status: SyncStatus) {
    let manager = app.state::<SyncManager>();
    *manager.status.lock().unwrap() = Some(status.clone());
    let _ = app.emit("sync-status", &status);
    crate::tray::refresh(app);
}

fn fail(app: &AppHandle, code: &str, message: String) -> Result<(), String> {
    logs::write(app, "error", "app", "sync.error", message.clone(), Some(json!({ "code": code })));
    set_status(app, SyncStatus::Error { code: code.into(), message: message.clone() });
    Err(message)
}

pub fn bridge_access() -> Result<(BridgeAccess, Option<String>), String> {
    let settings = crate::config::read_bridge_settings().ok_or("No bridge configured.")?;
    let access = BridgeAccess {
        ip: settings.bridge_ip.ok_or("No bridge configured.")?,
        key: settings.application_key.ok_or("No bridge configured.")?,
        pin: settings.cert_fingerprint,
    };
    Ok((access, settings.client_key))
}

pub async fn start(app: &AppHandle, request: SyncRequest) -> Result<(), String> {
    let manager = app.state::<SyncManager>();
    let mut session = manager.session.lock().await;
    if let Some(running) = session.take() {
        stop_session(running).await;
    }
    *manager.last_request.lock().unwrap() = Some(request.clone());
    set_status(app, SyncStatus::Starting { area_id: request.area_id.clone() });

    let (access, client_key) = match bridge_access() {
        Ok(found) => found,
        Err(message) => return fail(app, "not_configured", message),
    };
    let Some(client_key) = client_key else {
        return fail(app, "client_key", "Pair the bridge again to enable sync.".into());
    };
    let hue = app.state::<HueState>();

    let areas = match access.areas(&hue).await {
        Ok(areas) => areas,
        Err(message) => return fail(app, "bridge", message),
    };
    let Some(area) = areas.iter().find(|a| a.id == request.area_id).cloned() else {
        return fail(app, "area_missing", "The sync area no longer exists.".into());
    };

    // One stream per bridge: someone else's must end first.
    if let Some(busy) = areas.iter().find(|a| a.status == "active") {
        if !request.take_over {
            return fail(app, "busy", format!("Another app is syncing “{}”.", busy.name));
        }
        logs::write(app, "warn", "app", "sync.take_over", format!("Stopping the stream on “{}”", busy.name), None);
        let _ = access.set_streaming(&hue, &busy.id, false).await;
    }

    let saved = if request.restore {
        access.light_snapshot(&hue, &area.light_ids).await.unwrap_or_else(|e| {
            logs::write(app, "warn", "app", "sync.snapshot_failed", e, None);
            Vec::new()
        })
    } else {
        Vec::new()
    };

    if let Err(message) = access.set_streaming(&hue, &area.id, true).await {
        return fail(app, "start_failed", message);
    }
    logs::write(
        app,
        "info",
        "app",
        "sync.start",
        format!("Sync started on “{}” ({})", area.name, request.mode),
        Some(json!({ "area": area.name, "mode": request.mode, "channels": area.channels.len(), "intensity": request.intensity })),
    );

    let effect: Box<dyn Effect> = Box::new(PaletteCycle::new(
        request.palette.iter().filter_map(|h| effects::parse_hex(h)).collect(),
        request.intensity,
    ));

    let stop = Arc::new(AtomicBool::new(false));
    let thread = std::thread::Builder::new().name("hue-sync-stream".into()).spawn({
        let (app, stop, area, ip, key) = (app.clone(), stop.clone(), area.clone(), access.ip.clone(), access.key.clone());
        move || stream_loop(&app, &stop, &area, &ip, &key, &client_key, effect)
    });
    let thread = match thread {
        Ok(thread) => thread,
        Err(e) => {
            let _ = access.set_streaming(&hue, &area.id, false).await;
            return fail(app, "thread", e.to_string());
        }
    };

    let supervisor = tauri::async_runtime::spawn({
        let (app, stop) = (app.clone(), stop.clone());
        async move {
            let result = tauri::async_runtime::spawn_blocking(move || thread.join())
                .await
                .map_err(|e| e.to_string())
                .and_then(|joined| joined.map_err(|_| "stream thread panicked".to_string()))
                .and_then(|r| r);
            finish(&app, &access, &area, &saved, result, stop.load(Ordering::SeqCst)).await;
        }
    });

    *session = Some(Session { stop, supervisor });
    Ok(())
}

pub async fn stop(app: &AppHandle) {
    let manager = app.state::<SyncManager>();
    let mut session = manager.session.lock().await;
    if let Some(running) = session.take() {
        set_status(app, SyncStatus::Stopping);
        stop_session(running).await;
    }
}

async fn stop_session(session: Session) {
    session.stop.store(true, Ordering::SeqCst);
    let _ = session.supervisor.await;
}

/// The single cleanup path for every way a session ends.
async fn finish(
    app: &AppHandle,
    access: &BridgeAccess,
    area: &Area,
    saved: &[(String, Value)],
    result: Result<u32, String>,
    stopped_by_us: bool,
) {
    let hue = app.state::<HueState>();
    if let Err(e) = access.set_streaming(&hue, &area.id, false).await {
        logs::write(app, "warn", "app", "sync.stop_failed", e, None);
    }
    if !saved.is_empty() {
        // The bridge needs a moment after `stop` before it takes REST commands.
        tokio::time::sleep(Duration::from_millis(300)).await;
        if let Err(e) = access.restore_lights(&hue, saved).await {
            logs::write(app, "warn", "app", "sync.restore_failed", e, None);
        }
    }

    match result {
        Err(message) if !stopped_by_us => {
            let code = if message.contains("DTLS") { "network" } else { "stream" };
            let _ = fail(app, code, message);
        }
        result => {
            logs::write(
                app,
                "info",
                "app",
                "sync.stop",
                format!("Sync stopped on “{}”", area.name),
                Some(json!({ "packets": result.as_ref().ok(), "restored": !saved.is_empty() })),
            );
            set_status(app, SyncStatus::Idle);
        }
    }
}

/// The stream thread: connect, then render → encode → send at 50 Hz until
/// told to stop. Returns the number of packets sent.
fn stream_loop(
    app: &AppHandle,
    stop: &AtomicBool,
    area: &Area,
    ip: &str,
    key: &str,
    client_key: &str,
    mut effect: Box<dyn Effect>,
) -> Result<u32, String> {
    let connected = Instant::now();
    let mut stream = DtlsStream::connect(ip, key, client_key)?;
    logs::write(app, "debug", "app", "sync.connected", format!("DTLS connected in {} ms", connected.elapsed().as_millis()), None);
    set_status(app, SyncStatus::Streaming { area_id: area.id.clone(), light_ids: area.light_ids.clone() });

    let mut sent: u32 = 0;
    let mut last = Instant::now();
    let mut next_frame = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f32();
        last = now;

        let colors = effect.render(dt, &area.channels);
        let channels: Vec<ChannelColor> = area
            .channels
            .iter()
            .zip(&colors)
            .map(|(c, rgb)| ChannelColor::rgb(c.channel_id, rgb[0], rgb[1], rgb[2]))
            .collect();
        stream.send(&encode(sent as u8, &area.id, ColorSpace::Rgb, &channels)?)?;
        sent = sent.wrapping_add(1);

        if sent.is_multiple_of(PREVIEW_EVERY) {
            let preview: Vec<String> = colors.iter().map(|c| to_hex(*c)).collect();
            let _ = app.emit("sync-preview", preview);
        }

        next_frame += FRAME;
        if let Some(wait) = next_frame.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        } else {
            next_frame = Instant::now(); // fell behind; don't try to catch up
        }
    }
    stream.close();
    Ok(sent)
}

/// Linear RGB back to "#RRGGBB" (sRGB) for the UI preview.
fn to_hex(rgb: [f32; 3]) -> String {
    let encode = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        let s = if v <= 0.003_130_8 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
        (s * 255.0).round() as u8
    };
    format!("#{:02X}{:02X}{:02X}", encode(rgb[0]), encode(rgb[1]), encode(rgb[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_for_the_ui() {
        let status = SyncStatus::Streaming { area_id: "a".into(), light_ids: vec!["l".into()] };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "streaming", "areaId": "a", "lightIds": ["l"] })
        );
        assert_eq!(serde_json::to_value(SyncStatus::Idle).unwrap(), json!({ "state": "idle" }));
    }

    #[test]
    fn preview_hex_round_trips_with_effects_parser() {
        for hex in ["#FF5E5B", "#00B4D8", "#FFFFFF", "#000000"] {
            assert_eq!(to_hex(effects::parse_hex(hex).unwrap()), hex);
        }
    }
}
