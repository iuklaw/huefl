// Screen capture on Wayland, where apps can't read the screen themselves:
// the xdg-desktop-portal ScreenCast asks the user which monitor to share (a
// system dialog), then the picture arrives as a PipeWire video stream. The
// same way OBS, browsers and Discord do it; works on KDE, GNOME and wlroots.
//
//   portal: CreateSession → SelectSources (one monitor, no cursor,
//           persistent) → Start (the dialog) → OpenPipeWireRemote (an fd)
//   thread: PipeWire main loop on that fd → a video stream from the node →
//           each frame averaged into zones::Grid, like X11 frames
//
// The portal hands out a restore token: next time the same monitor is shared
// without asking (KDE Plasma 5.27+, GNOME 44+; older portals ask each time).
// It's kept in the state dir; "Choose another screen" deletes it.
//
// Shared memory only (no DMA-BUF): the frame is read on the CPU anyway, and a
// 32 × 18 grid doesn't need the GPU path's speed.

use std::io::Cursor;
use std::os::fd::{IntoRawFd, OwnedFd};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use ashpd::desktop::{PersistMode, ResponseError, Session};
use serde::{Deserialize, Serialize};
use libspa::pod::serialize::PodSerializer;
use libspa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
use libspa::utils::{Choice, ChoiceEnum, ChoiceFlags, Fraction, Id, Rectangle};
use pipewire as pw;
use pw::prelude::*;
use libspa_sys as spa_sys;

use super::capture::{EventSink, ScreenEvent};
use super::zones::{grid_from_frame, Grid, PixelOrder};

/// Frames a second we look at; the rest are dropped (lights update ~25 Hz).
const MAX_FPS: u32 = 25;
/// How long frames may stay unreadable after asking for shared memory.
const UNREADABLE_FOR: Duration = Duration::from_secs(3);
/// Ends the messages for capture that can't work - only a report helps.
const REPORT: &str = "Please report it with the log (Options → About → Report a bug).";

/// Why opening failed: the user said no, or something else.
#[derive(Debug)]
pub enum OpenError {
    Cancelled,
    Failed(String),
}

impl From<ashpd::Error> for OpenError {
    fn from(error: ashpd::Error) -> Self {
        match error {
            ashpd::Error::Response(ResponseError::Cancelled) => OpenError::Cancelled,
            other => OpenError::Failed(format!("Screen sharing failed: {other}")),
        }
    }
}

/// Is there a ScreenCast portal that can share a monitor?
pub async fn available() -> bool {
    match Screencast::new().await {
        Ok(proxy) => proxy
            .available_source_types()
            .await
            .map(|types| types.contains(SourceType::Monitor))
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// The monitor last shared, as the portal lets us remember it: a restore
/// token, and the stream's size (the portal gives no monitor names).
#[derive(Serialize, Deserialize, Default)]
struct Saved {
    token: String,
    width: Option<u32>,
    height: Option<u32>,
}

fn saved_path() -> PathBuf {
    crate::paths::state_dir().join("screencast.json")
}

fn load_saved() -> Option<Saved> {
    if let Ok(text) = std::fs::read_to_string(saved_path()) {
        return serde_json::from_str::<Saved>(&text).ok().filter(|s| !s.token.is_empty());
    }
    // Before the size was kept: a bare token file.
    let legacy = crate::paths::state_dir().join("screencast-token");
    let token = std::fs::read_to_string(&legacy).ok()?.trim().to_string();
    let _ = std::fs::remove_file(legacy);
    (!token.is_empty()).then(|| {
        let saved = Saved { token, ..Default::default() };
        store(&saved);
        saved
    })
}

fn store(saved: &Saved) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = saved_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(json) = serde_json::to_string(saved) else { return };
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(path) {
        let _ = file.write_all(json.as_bytes());
    }
}

/// The remembered screen's size (0 × 0 if unknown), if the next start won't ask.
pub fn shared_screen() -> Option<(u32, u32)> {
    let saved = load_saved()?;
    Some((saved.width.unwrap_or(0), saved.height.unwrap_or(0)))
}

/// Forget the shared monitor: the next start asks again.
pub fn forget() {
    let _ = std::fs::remove_file(saved_path());
    let _ = std::fs::remove_file(crate::paths::state_dir().join("screencast-token"));
}

/// Runs the portal's choice (its dialog, unless `remembered` still holds) and
/// keeps the answer. Returns the session and the chosen stream.
async fn choose(
    proxy: &Screencast,
    remembered: bool,
) -> Result<(Session<Screencast>, ashpd::desktop::screencast::Stream), OpenError> {
    let token = if remembered { load_saved().map(|s| s.token) } else { None };
    match choose_once(proxy, token.as_deref()).await {
        // A token the portal won't take (malformed, from another portal
        // version) fails instead of falling back to the dialog: forget it
        // and ask, once.
        Err(OpenError::Failed(_)) if token.is_some() => {
            forget();
            choose_once(proxy, None).await
        }
        result => result,
    }
}

/// One session through SelectSources and Start; closed again if that fails.
async fn choose_once(
    proxy: &Screencast,
    token: Option<&str>,
) -> Result<(Session<Screencast>, ashpd::desktop::screencast::Stream), OpenError> {
    let session = proxy.create_session(Default::default()).await?;
    match select_and_start(proxy, &session, token).await {
        Ok(stream) => Ok((session, stream)),
        Err(e) => {
            let _ = session.close().await;
            Err(e)
        }
    }
}

async fn select_and_start(
    proxy: &Screencast,
    session: &Session<Screencast>,
    token: Option<&str>,
) -> Result<ashpd::desktop::screencast::Stream, OpenError> {
    let options = SelectSourcesOptions::default()
        .set_cursor_mode(CursorMode::Hidden)
        .set_sources(ashpd::enumflags2::BitFlags::from(SourceType::Monitor))
        .set_multiple(false)
        .set_persist_mode(PersistMode::ExplicitlyRevoked)
        .set_restore_token(token);
    proxy.select_sources(session, options).await?.response()?;
    let streams = proxy.start(session, None, Default::default()).await?.response()?;
    let Some(stream) = streams.streams().first().cloned() else {
        return Err(OpenError::Failed("The portal shared no screen.".into()));
    };
    match streams.restore_token() {
        Some(token) => {
            let size = stream.size();
            store(&Saved {
                token: token.to_string(),
                width: size.map(|(w, _)| w.max(0) as u32),
                height: size.map(|(_, h)| h.max(0) as u32),
            });
        }
        // A portal without restore tokens asks every time: nothing to keep.
        None => forget(),
    }
    Ok(stream)
}

/// "Change screen…": the portal's dialog now, remembering the answer for
/// the next start. No stream is opened.
pub async fn pick() -> Result<(), OpenError> {
    let proxy = Screencast::new().await?;
    let (session, _) = choose(&proxy, false).await?;
    let _ = session.close().await;
    Ok(())
}

/// A running capture: the portal session (sharing ends when it closes) and
/// the PipeWire thread.
pub struct Cast {
    session: Option<Session<Screencast>>,
    stop: Arc<AtomicBool>,
    quit: pw::channel::Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Cast {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.quit.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        // Tell the compositor we're done (drops its "sharing" indicator).
        if let Some(session) = self.session.take() {
            tauri::async_runtime::spawn(async move {
                let _ = session.close().await;
            });
        }
    }
}

/// Asks for a monitor (the system dialog, unless a restore token still
/// holds) and starts receiving it.
pub async fn open(grid: Arc<Mutex<Option<Grid>>>, lost: Arc<AtomicBool>, on_event: EventSink) -> Result<Cast, OpenError> {
    let proxy = Screencast::new().await?;
    let (session, stream) = choose(&proxy, true).await?;
    let node = stream.pipe_wire_node_id();
    let size = stream.size();
    let fd = proxy.open_pipe_wire_remote(&session, Default::default()).await?;

    let stop = Arc::new(AtomicBool::new(false));
    let (quit, quit_rx) = pw::channel::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let thread = std::thread::Builder::new()
        .name("hue-sync-screen-pw".into())
        .spawn({
            let stop = stop.clone();
            move || {
                if let Err(e) = run(fd, node, grid, lost, on_event, stop, quit_rx, &ready_tx) {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| OpenError::Failed(e.to_string()))?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(Cast { session: Some(session), stop, quit, thread: Some(thread) }),
        Ok(Err(e)) => {
            let _ = thread.join();
            let _ = session.close().await;
            Err(OpenError::Failed(e))
        }
        Err(_) => Err(OpenError::Failed(format!("screen capture ended unexpectedly (stream {node}, {size:?})"))),
    }
}

/// What the stream callbacks share.
struct StreamState {
    grid: Arc<Mutex<Option<Grid>>>,
    lost: Arc<AtomicBool>,
    /// Shared with `run`, which reports the end of the share (one thread).
    on_event: Rc<EventSink>,
    /// Negotiated: width, height, byte order.
    format: Option<(usize, usize, PixelOrder)>,
    last_frame: Option<Instant>,
    /// When frames we can't read (GPU memory) made us ask for shared memory
    /// instead; reset by the first readable frame.
    unreadable_since: Option<Instant>,
    /// Said once that capture can't work; the session is ending.
    failed: bool,
    /// One log line, not one per frame.
    logged_first_frame: bool,
}

impl Default for StreamState {
    fn default() -> Self {
        // Required by the stream API; real state is set right away.
        StreamState {
            grid: Arc::default(),
            lost: Arc::default(),
            on_event: Rc::new(Box::new(|_| {})),
            format: None,
            last_frame: None,
            unreadable_since: None,
            failed: false,
            logged_first_frame: false,
        }
    }
}

impl StreamState {
    fn fail(&mut self, message: String) {
        if !std::mem::replace(&mut self.failed, true) {
            (self.on_event)(ScreenEvent::Failed(message));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    fd: OwnedFd,
    node: u32,
    grid: Arc<Mutex<Option<Grid>>>,
    lost: Arc<AtomicBool>,
    on_event: EventSink,
    stop: Arc<AtomicBool>,
    quit: pw::channel::Receiver<()>,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    pw::init();
    let mainloop = pw::MainLoop::new().map_err(|e| format!("PipeWire: {e}"))?;
    let context = pw::Context::new(&mainloop).map_err(|e| format!("PipeWire: {e}"))?;
    // PipeWire owns the fd from here on.
    let core = context.connect_fd(fd.into_raw_fd(), None).map_err(|e| format!("PipeWire: {e}"))?;
    let mut stream = pw::stream::Stream::<StreamState>::new(
        &core,
        "HueFL screen sync",
        pw::properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| format!("PipeWire: {e}"))?;

    let shared_memory = buffers_param().map_err(|e| format!("PipeWire buffers: {e}"))?;
    let on_event = Rc::new(on_event);
    let weak = mainloop.downgrade();
    let _listener = stream
        .add_local_listener_with_user_data(StreamState {
            grid: grid.clone(),
            lost: lost.clone(),
            on_event: on_event.clone(),
            ..Default::default()
        })
        .state_changed(move |_, new| {
            // The compositor ended the share (stopped from its panel, screen
            // locked): nothing more will come.
            if matches!(new, pw::stream::StreamState::Unconnected | pw::stream::StreamState::Error(_)) {
                if let Some(mainloop) = weak.upgrade() {
                    mainloop.quit();
                }
            }
        })
        .param_changed(|id, state, param| {
            if id != spa_sys::SPA_PARAM_Format || param.is_null() {
                return;
            }
            let bytes = unsafe { pod_bytes(param) };
            match parse_format(bytes) {
                Ok((w, h, order)) => {
                    state.format = Some((w, h, order));
                    (state.on_event)(ScreenEvent::Opened(format!("the shared screen ({w}×{h}, {order:?})")));
                }
                Err(why) => {
                    state.format = None;
                    state.fail(format!("Can't read the screen's video format ({why}). {REPORT}"));
                }
            }
        })
        .process(move |stream, state| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return };
            let Some((width, height, order)) = state.format else { return };
            // Enough for the lights; the rest is wasted work.
            if state.last_frame.is_some_and(|t| t.elapsed() < Duration::from_millis(1000 / MAX_FPS as u64)) {
                return;
            }
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else { return };
            let kind = data.type_();
            let (offset, size, stride) = {
                let chunk = data.chunk();
                (chunk.offset() as usize, chunk.size() as usize, chunk.stride())
            };
            let stride = if stride > 0 { stride as usize } else { width * 4 };
            let Some(bytes) = data.data() else {
                // Not mapped: a GPU buffer (DMA-BUF) we don't read. Ask for
                // shared memory instead; if frames still can't be read after
                // a while, say so rather than keep the lights dark.
                match state.unreadable_since {
                    None => {
                        state.unreadable_since = Some(Instant::now());
                        (state.on_event)(ScreenEvent::Detail {
                            code: "sync.screen_unreadable",
                            message: format!("Screen frames arrive as {kind:?}, which can't be read; asking for shared memory"),
                            warn: true,
                        });
                        let mut params = [shared_memory.as_ptr() as *const spa_sys::spa_pod];
                        if let Err(e) = stream.update_params(&mut params) {
                            state.fail(format!("Screen frames arrive as {kind:?}, which can't be read ({e}). {REPORT}"));
                        }
                    }
                    Some(since) if since.elapsed() > UNREADABLE_FOR => {
                        state.fail(format!("Your desktop sends the screen as {kind:?}, which HueFL can't read. {REPORT}"));
                    }
                    Some(_) => {}
                }
                return;
            };
            state.unreadable_since = None;
            if !std::mem::replace(&mut state.logged_first_frame, true) {
                (state.on_event)(ScreenEvent::Detail {
                    code: "sync.screen_first_frame",
                    message: format!("First frame: {kind:?}, {} bytes mapped, chunk {offset}+{size}, stride {stride}", bytes.len()),
                    warn: false,
                });
            }
            // Some producers leave the chunk's size at 0 for a full frame.
            let end = if size == 0 { bytes.len() } else { (offset + size).min(bytes.len()) };
            let Some(frame) = bytes.get(offset..end) else { return };
            if frame.len() < stride * (height - 1) + width * 4 {
                return; // empty or partial buffer (e.g. only cursor updates)
            }
            *state.grid.lock().unwrap() = Some(grid_from_frame(frame, width, height, stride, order));
            state.last_frame = Some(Instant::now());
            if state.lost.swap(false, Ordering::SeqCst) {
                (state.on_event)(ScreenEvent::Restored);
            }
        })
        .register()
        .map_err(|e| format!("PipeWire: {e}"))?;

    let format = enum_format().map_err(|e| format!("PipeWire format: {e}"))?;
    let mut params = [format.as_ptr() as *const spa_sys::spa_pod];
    stream
        .connect(
            pw::spa::Direction::Input,
            Some(node),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(|e| format!("PipeWire: {e}"))?;

    let _quit = quit.attach(&mainloop, {
        let weak = mainloop.downgrade();
        move |_| {
            if let Some(mainloop) = weak.upgrade() {
                mainloop.quit();
            }
        }
    });
    let _ = ready.send(Ok(()));
    mainloop.run();

    // Ended by the compositor rather than by us (stopped from its panel,
    // screen locked): the lights go dark and the UI says it's waiting.
    if !stop.load(Ordering::SeqCst) {
        *grid.lock().unwrap() = None;
        if !lost.swap(true, Ordering::SeqCst) {
            on_event(ScreenEvent::Lost("screen sharing was stopped".into()));
        }
    }
    Ok(())
}

/// What we accept: raw video, 4 bytes per pixel in any common order, any
/// size, up to MAX_FPS.
fn enum_format() -> Result<Vec<u8>, String> {
    let formats = [
        spa_sys::SPA_VIDEO_FORMAT_BGRx,
        spa_sys::SPA_VIDEO_FORMAT_BGRA,
        spa_sys::SPA_VIDEO_FORMAT_RGBx,
        spa_sys::SPA_VIDEO_FORMAT_RGBA,
        spa_sys::SPA_VIDEO_FORMAT_xRGB,
        spa_sys::SPA_VIDEO_FORMAT_xBGR,
    ];
    let property = |key: u32, value: Value| Property { key, flags: PropertyFlags::empty(), value };
    let object = Value::Object(Object {
        type_: spa_sys::SPA_TYPE_OBJECT_Format,
        id: spa_sys::SPA_PARAM_EnumFormat,
        properties: vec![
            property(spa_sys::SPA_FORMAT_mediaType, Value::Id(Id(spa_sys::SPA_MEDIA_TYPE_video))),
            property(spa_sys::SPA_FORMAT_mediaSubtype, Value::Id(Id(spa_sys::SPA_MEDIA_SUBTYPE_raw))),
            property(
                spa_sys::SPA_FORMAT_VIDEO_format,
                Value::Choice(ChoiceValue::Id(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Enum { default: Id(formats[0]), alternatives: formats.iter().map(|f| Id(*f)).collect() },
                ))),
            ),
            property(
                spa_sys::SPA_FORMAT_VIDEO_size,
                Value::Choice(ChoiceValue::Rectangle(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: Rectangle { width: 1920, height: 1080 },
                        min: Rectangle { width: 1, height: 1 },
                        max: Rectangle { width: 8192, height: 8192 },
                    },
                ))),
            ),
            property(
                spa_sys::SPA_FORMAT_VIDEO_framerate,
                Value::Choice(ChoiceValue::Fraction(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: Fraction { num: MAX_FPS, denom: 1 },
                        min: Fraction { num: 0, denom: 1 },
                        max: Fraction { num: 240, denom: 1 },
                    },
                ))),
            ),
        ],
    });
    PodSerializer::serialize(Cursor::new(Vec::new()), &object)
        .map(|(cursor, _)| cursor.into_inner())
        .map_err(|e| format!("{e:?}"))
}

/// Buffers in plain or fd-backed shared memory - what `data()` can map -
/// rather than GPU memory (DMA-BUF), which some compositors pick by default.
fn buffers_param() -> Result<Vec<u8>, String> {
    let object = Value::Object(Object {
        type_: spa_sys::SPA_TYPE_OBJECT_ParamBuffers,
        id: spa_sys::SPA_PARAM_Buffers,
        properties: vec![Property {
            key: spa_sys::SPA_PARAM_BUFFERS_dataType,
            flags: PropertyFlags::empty(),
            value: Value::Int((1 << spa_sys::SPA_DATA_MemPtr) | (1 << spa_sys::SPA_DATA_MemFd)),
        }],
    });
    PodSerializer::serialize(Cursor::new(Vec::new()), &object)
        .map(|(cursor, _)| cursor.into_inner())
        .map_err(|e| format!("{e:?}"))
}

/// The bytes of a pod: an 8-byte header (size, type) and `size` more.
///
/// # Safety
/// `param` must point to a valid pod, as PipeWire hands them to callbacks.
unsafe fn pod_bytes<'a>(param: *const spa_sys::spa_pod) -> &'a [u8] {
    let size = (*param).size as usize + std::mem::size_of::<spa_sys::spa_pod>();
    std::slice::from_raw_parts(param as *const u8, size)
}

/// The negotiated format: size and byte order, or why it can't be read.
///
/// Read by hand rather than with libspa's deserializer: a negotiated format
/// keeps its values wrapped in (fixated) choices, and may carry properties
/// the deserializer doesn't know - both made it give up, which left the
/// picture black on KDE.
fn parse_format(bytes: &[u8]) -> Result<(usize, usize, PixelOrder), String> {
    let props = object_properties(bytes).ok_or("not a format object")?;
    let mut size = None;
    let mut format = None;
    for &(key, kind, value) in &props {
        if key == spa_sys::SPA_FORMAT_VIDEO_size && kind == spa_sys::SPA_TYPE_Rectangle {
            size = u32_at(value, 0).zip(u32_at(value, 4)).map(|(w, h)| (w as usize, h as usize));
        } else if key == spa_sys::SPA_FORMAT_VIDEO_format && kind == spa_sys::SPA_TYPE_Id {
            format = u32_at(value, 0);
        }
    }
    let describe = || props.iter().map(|(k, t, _)| format!("{k}:{t}")).collect::<Vec<_>>().join(" ");
    let (width, height) = size.filter(|(w, h)| *w > 0 && *h > 0).ok_or_else(|| format!("no size ({})", describe()))?;
    let format = format.ok_or_else(|| format!("no pixel format ({})", describe()))?;
    let order = pixel_order(format).ok_or_else(|| format!("pixel format {format} not supported"))?;
    Ok((width, height, order))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_ne_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// An SPA object pod's properties as (key, value type, value bytes). A value
/// wrapped in a choice is reported as its first (default) value.
fn object_properties(bytes: &[u8]) -> Option<Vec<(u32, u32, &[u8])>> {
    let size = u32_at(bytes, 0)? as usize;
    if u32_at(bytes, 4)? != spa_sys::SPA_TYPE_Object {
        return None;
    }
    let body = bytes.get(8..8 + size)?;
    let mut props = Vec::new();
    let mut at = 8; // past the object's own type and id
    while at + 16 <= body.len() {
        let key = u32_at(body, at)?;
        let value_size = u32_at(body, at + 8)? as usize;
        let value_type = u32_at(body, at + 12)?;
        let value = body.get(at + 16..at + 16 + value_size)?;
        let (kind, value) = if value_type == spa_sys::SPA_TYPE_Choice {
            // choice type, flags, then the child pod's header and its values.
            let child_size = u32_at(value, 8)? as usize;
            let child_type = u32_at(value, 12)?;
            (child_type, value.get(16..16 + child_size)?)
        } else {
            (value_type, value)
        };
        props.push((key, kind, value));
        at += 16 + value_size.div_ceil(8) * 8;
    }
    Some(props)
}

fn pixel_order(format: u32) -> Option<PixelOrder> {
    match format {
        f if f == spa_sys::SPA_VIDEO_FORMAT_BGRx || f == spa_sys::SPA_VIDEO_FORMAT_BGRA => Some(PixelOrder::Bgrx),
        f if f == spa_sys::SPA_VIDEO_FORMAT_RGBx || f == spa_sys::SPA_VIDEO_FORMAT_RGBA => Some(PixelOrder::Rgbx),
        f if f == spa_sys::SPA_VIDEO_FORMAT_xRGB => Some(PixelOrder::Xrgb),
        f if f == spa_sys::SPA_VIDEO_FORMAT_xBGR => Some(PixelOrder::Xbgr),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize(value: &Value) -> Vec<u8> {
        PodSerializer::serialize(Cursor::new(Vec::new()), value).unwrap().0.into_inner()
    }

    fn format_object(size: Value, pixel: Value, extra: Vec<Property>) -> Value {
        let prop = |key, value| Property { key, flags: PropertyFlags::empty(), value };
        let mut properties = vec![
            prop(spa_sys::SPA_FORMAT_mediaType, Value::Id(Id(spa_sys::SPA_MEDIA_TYPE_video))),
            prop(spa_sys::SPA_FORMAT_mediaSubtype, Value::Id(Id(spa_sys::SPA_MEDIA_SUBTYPE_raw))),
            prop(spa_sys::SPA_FORMAT_VIDEO_format, pixel),
            prop(spa_sys::SPA_FORMAT_VIDEO_size, size),
        ];
        properties.extend(extra);
        Value::Object(Object { type_: spa_sys::SPA_TYPE_OBJECT_Format, id: spa_sys::SPA_PARAM_Format, properties })
    }

    #[test]
    fn reads_a_plain_format() {
        let pod = serialize(&format_object(
            Value::Rectangle(Rectangle { width: 1280, height: 800 }),
            Value::Id(Id(spa_sys::SPA_VIDEO_FORMAT_RGBx)),
            vec![],
        ));
        assert_eq!(parse_format(&pod), Ok((1280, 800, PixelOrder::Rgbx)));
    }

    /// What KWin and Mutter actually send: fixated values still wrapped in
    /// choices of type None - the cause of the black picture on the Deck.
    #[test]
    fn reads_values_wrapped_in_fixated_choices() {
        let pod = serialize(&format_object(
            Value::Choice(ChoiceValue::Rectangle(Choice(ChoiceFlags::empty(), ChoiceEnum::None(Rectangle { width: 1280, height: 800 })))),
            Value::Choice(ChoiceValue::Id(Choice(ChoiceFlags::empty(), ChoiceEnum::None(Id(spa_sys::SPA_VIDEO_FORMAT_BGRx))))),
            vec![],
        ));
        assert_eq!(parse_format(&pod), Ok((1280, 800, PixelOrder::Bgrx)));
    }

    #[test]
    fn skips_properties_it_does_not_know() {
        let pod = serialize(&format_object(
            Value::Rectangle(Rectangle { width: 1920, height: 1080 }),
            Value::Id(Id(spa_sys::SPA_VIDEO_FORMAT_BGRA)),
            vec![
                Property { key: 0x2_0000, flags: PropertyFlags::empty(), value: Value::Long(123) },
                Property { key: 0x2_0001, flags: PropertyFlags::empty(), value: Value::String("odd".into()) },
            ],
        ));
        assert_eq!(parse_format(&pod), Ok((1920, 1080, PixelOrder::Bgrx)));
    }

    #[test]
    fn broken_bytes_are_an_error_not_a_crash() {
        let pod = serialize(&format_object(
            Value::Rectangle(Rectangle { width: 1920, height: 1080 }),
            Value::Id(Id(spa_sys::SPA_VIDEO_FORMAT_BGRx)),
            vec![],
        ));
        for cut in [0, 7, 12, 40, pod.len() - 3] {
            assert!(parse_format(&pod[..cut]).is_err(), "cut at {cut}");
        }
        assert!(parse_format(&serialize(&Value::Int(5))).is_err());
    }

    #[test]
    fn our_offer_serializes() {
        let bytes = enum_format().unwrap();
        assert!(bytes.len() > 64, "{} bytes", bytes.len());
    }

    /// Live, no dialog: is a ScreenCast portal there?
    /// `cargo test --lib live_portal_available -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_portal_available() {
        println!("ScreenCast portal able to share a monitor: {}", available().await);
    }

    /// Live: share a screen through the portal for 3 s and print the grid.
    /// Needs a Wayland session. `cargo test --lib live_portal -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_portal() {
        let grid = Arc::new(Mutex::new(None));
        let cast = open(grid.clone(), Arc::default(), Box::new(|e| println!("event: {e:?}"))).await;
        match cast {
            Ok(cast) => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                println!("grid: {:?}", grid.lock().unwrap().as_ref().map(|g| g.cells.len()));
                drop(cast);
            }
            Err(e) => println!("open failed: {e:?}"),
        }
    }
}
