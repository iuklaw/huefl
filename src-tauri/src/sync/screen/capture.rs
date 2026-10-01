// Captures one monitor for screen sync, keeping the latest coarse grid
// (zones::Grid) in shared memory for the effect. Two backends:
//   X11      here, on its own thread (below);
//   Wayland  the desktop portal + PipeWire (portal.rs), chosen by session.
//
// X11:
//
// MIT-SHM: the X server writes each frame straight into a shared-memory
// segment instead of sending megabytes over the socket - a 1080p frame costs
// a few milliseconds. ~25 captures per second is plenty for lights (the
// bridge updates them at ~25 Hz anyway).
//
// Kept working mid-sync: a resolution / layout change is noticed within 2 s
// and the capture is set up again; if the display goes away, the grid is
// cleared (lights dim), `lost` is raised and the thread retries.
//
// RAII: dropping a `ScreenSource` stops and joins the thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Serialize;

use super::zones::Grid;

/// A monitor to pick in the UI.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    /// RandR name, e.g. "HDMI-0", "eDP-1-1" - stable across restarts.
    pub name: String,
    pub width: u16,
    pub height: u16,
    pub primary: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ScreenEvent {
    Opened(String),
    Lost(String),
    Restored,
    /// A detail worth a log line (format negotiated, first frame, …).
    Detail { code: &'static str, message: String, warn: bool },
}

pub type EventSink = Box<dyn Fn(ScreenEvent) + Send>;

pub struct ScreenSource {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    /// Wayland: the portal session and PipeWire thread (stop on drop).
    #[cfg(feature = "sync-screen-wayland")]
    _cast: Option<super::portal::Cast>,
}

/// Starting on Wayland can end with the user declining the portal's dialog.
#[derive(Debug)]
pub enum StartError {
    Cancelled,
    Failed(String),
}

/// Wayland session: capture goes through the desktop portal.
pub fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland")
}

/// Why screen sync can't run here, for the readiness list (None: it can).
pub async fn availability() -> Option<&'static str> {
    if !cfg!(feature = "sync-screen") {
        return Some("unsupported");
    }
    if is_wayland() {
        #[cfg(feature = "sync-screen-wayland")]
        return (!super::portal::available().await).then_some("no_portal");
        #[cfg(not(feature = "sync-screen-wayland"))]
        return Some("unsupported");
    }
    if std::env::var_os("DISPLAY").is_none() {
        return Some("no_display");
    }
    None
}

impl Drop for ScreenSource {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}


#[cfg(feature = "sync-screen")]
mod x11 {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use x11rb::connection::Connection;
    use x11rb::protocol::randr::ConnectionExt as _;
    use x11rb::protocol::shm::{self, ConnectionExt as _};
    use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, Window};
    use x11rb::rust_connection::RustConnection;

    use super::{EventSink, Monitor, ScreenEvent, ScreenSource};
    use crate::sync::screen::zones::{grid_from_bgrx, Grid};

    const FRAME: Duration = Duration::from_millis(40); // 25 fps
    const LAYOUT_CHECK: Duration = Duration::from_secs(2);
    const RETRY: Duration = Duration::from_secs(1);

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    struct Rect {
        x: i16,
        y: i16,
        width: u16,
        height: u16,
    }

    fn connect() -> Result<(RustConnection, Window), String> {
        let (conn, screen) = RustConnection::connect(None).map_err(|e| format!("Can't open the display: {e}"))?;
        let root = conn.setup().roots[screen].root;
        Ok((conn, root))
    }

    fn list(conn: &RustConnection, root: Window) -> Result<Vec<(Monitor, Rect)>, String> {
        let reply = conn
            .randr_get_monitors(root, true)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        reply
            .monitors
            .iter()
            .map(|m| {
                let name = conn
                    .get_atom_name(m.name)
                    .map_err(|e| e.to_string())?
                    .reply()
                    .map(|r| String::from_utf8_lossy(&r.name).into_owned())
                    .map_err(|e| e.to_string())?;
                Ok((
                    Monitor { name, width: m.width, height: m.height, primary: m.primary },
                    Rect { x: m.x, y: m.y, width: m.width, height: m.height },
                ))
            })
            .collect()
    }

    pub fn monitors() -> Result<Vec<Monitor>, String> {
        let (conn, root) = connect()?;
        Ok(list(&conn, root)?.into_iter().map(|(m, _)| m).collect())
    }

    /// The chosen monitor, else the primary, else the first.
    fn pick(monitors: &[(Monitor, Rect)], wanted: Option<&str>) -> Option<(String, Rect)> {
        monitors
            .iter()
            .find(|(m, _)| Some(m.name.as_str()) == wanted)
            .or_else(|| monitors.iter().find(|(m, _)| m.primary))
            .or_else(|| monitors.first())
            .map(|(m, r)| (m.name.clone(), *r))
    }

    /// Frames are read as BGRX: 32 bits per pixel, red in the high byte.
    fn check_pixel_format(conn: &RustConnection) -> Result<(), String> {
        let setup = conn.setup();
        let screen = &setup.roots[0];
        let bpp = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == screen.root_depth)
            .map(|f| f.bits_per_pixel);
        let red = screen
            .allowed_depths
            .iter()
            .flat_map(|d| &d.visuals)
            .find(|v| v.visual_id == screen.root_visual)
            .map(|v| v.red_mask);
        if bpp == Some(32) && red == Some(0x00FF_0000) {
            Ok(())
        } else {
            Err(format!("Unsupported screen pixel format (bpp {bpp:?}, red mask {red:?})"))
        }
    }

    /// A System V shared-memory segment attached to both us and the X server.
    struct Shared<'c> {
        conn: &'c RustConnection,
        seg: shm::Seg,
        addr: *mut libc::c_void,
        size: usize,
    }

    impl<'c> Shared<'c> {
        fn new(conn: &'c RustConnection, size: usize) -> Result<Self, String> {
            // SAFETY: plain SysV shm calls; results are checked before use.
            unsafe {
                let id = libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o600);
                if id < 0 {
                    return Err("shmget failed".into());
                }
                let addr = libc::shmat(id, std::ptr::null(), 0);
                if addr as isize == -1 {
                    libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
                    return Err("shmat failed".into());
                }
                let seg = conn.generate_id().map_err(|e| e.to_string())?;
                let attached = conn
                    .shm_attach(seg, id as u32, false)
                    .map_err(|e| e.to_string())
                    .and_then(|c| c.check().map_err(|e| e.to_string()));
                // Mark for removal now: the kernel frees it once both sides
                // detach, even if we crash.
                libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
                if let Err(e) = attached {
                    libc::shmdt(addr);
                    return Err(format!("MIT-SHM attach failed: {e}"));
                }
                Ok(Self { conn, seg, addr, size })
            }
        }

        fn bytes(&self) -> &[u8] {
            // SAFETY: `addr` maps `size` bytes for our lifetime; the server
            // has finished writing when shm_get_image's reply arrives.
            unsafe { std::slice::from_raw_parts(self.addr as *const u8, self.size) }
        }
    }

    impl Drop for Shared<'_> {
        fn drop(&mut self) {
            let _ = self.conn.shm_detach(self.seg);
            let _ = self.conn.flush();
            // SAFETY: detaching the mapping created in `new`.
            unsafe {
                libc::shmdt(self.addr);
            }
        }
    }

    /// One capture session on a fixed layout; returns when the layout changes,
    /// capture fails, or we are told to stop.
    fn run(
        wanted: Option<&str>,
        grid: &Mutex<Option<Grid>>,
        stop: &AtomicBool,
        on_open: &mut dyn FnMut(String),
    ) -> Result<(), String> {
        let (conn, root) = connect()?;
        check_pixel_format(&conn)?;
        let monitors = list(&conn, root)?;
        let (name, rect) = pick(&monitors, wanted).ok_or("No monitor found")?;
        let (w, h) = (rect.width as usize, rect.height as usize);
        let shared = Shared::new(&conn, w * h * 4)?;
        on_open(format!("{name} {w}×{h}"));

        let mut checked = Instant::now();
        let mut next = Instant::now();
        while !stop.load(Ordering::SeqCst) {
            // Waiting for the reply means the server has finished writing the frame.
            conn.shm_get_image(root, rect.x, rect.y, rect.width, rect.height, !0, ImageFormat::Z_PIXMAP.into(), shared.seg, 0)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            *grid.lock().unwrap() = Some(grid_from_bgrx(shared.bytes(), w, h, w * 4));

            if checked.elapsed() >= LAYOUT_CHECK {
                checked = Instant::now();
                let now = list(&conn, root)?;
                if pick(&now, wanted).map(|(_, r)| r) != Some(rect) {
                    return Ok(()); // resolution or layout changed: set up again
                }
            }
            next += FRAME;
            match next.checked_duration_since(Instant::now()) {
                Some(wait) => std::thread::sleep(wait),
                None => next = Instant::now(),
            }
        }
        Ok(())
    }

    pub fn start(
        monitor: Option<String>,
        grid: Arc<Mutex<Option<Grid>>>,
        lost: Arc<AtomicBool>,
        on_event: EventSink,
    ) -> Result<ScreenSource, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let thread = std::thread::Builder::new()
            .name("hue-sync-screen".into())
            .spawn({
                let stop = stop.clone();
                move || {
                    let mut ready = Some(ready_tx);
                    while !stop.load(Ordering::SeqCst) {
                        let mut on_open = |what: String| {
                            if let Some(ready) = ready.take() {
                                let _ = ready.send(Ok(()));
                            }
                            if lost.swap(false, Ordering::SeqCst) {
                                on_event(ScreenEvent::Restored);
                            }
                            on_event(ScreenEvent::Opened(what));
                        };
                        match run(monitor.as_deref(), &grid, &stop, &mut on_open) {
                            Ok(()) => {}
                            Err(e) => {
                                // The first attempt decides whether sync starts.
                                if let Some(ready) = ready.take() {
                                    let _ = ready.send(Err(e));
                                    return;
                                }
                                *grid.lock().unwrap() = None;
                                if !lost.swap(true, Ordering::SeqCst) {
                                    on_event(ScreenEvent::Lost(e));
                                }
                                std::thread::sleep(RETRY);
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(ScreenSource {
                stop,
                thread: Some(thread),
                #[cfg(feature = "sync-screen-wayland")]
                _cast: None,
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err("screen capture thread ended unexpectedly".into()),
        }
    }
}

impl ScreenSource {
    /// Starts capturing `monitor` (RandR name; None = primary). Fails if the
    /// screen can't be captured at all; later losses are handled inside.
    pub fn start(
        monitor: Option<String>,
        grid: Arc<Mutex<Option<Grid>>>,
        lost: Arc<AtomicBool>,
        on_event: EventSink,
    ) -> Result<Self, String> {
        #[cfg(feature = "sync-screen")]
        return x11::start(monitor, grid, lost, on_event);
        #[cfg(not(feature = "sync-screen"))]
        {
            let _ = (monitor, grid, lost, on_event);
            Err("This build has no screen support (feature sync-screen).".into())
        }
    }
}

impl ScreenSource {
    /// Wayland: asks the user which monitor to share (the system dialog,
    /// unless a remembered choice still holds) and starts receiving it.
    pub async fn start_portal(
        grid: Arc<Mutex<Option<Grid>>>,
        lost: Arc<AtomicBool>,
        on_event: EventSink,
    ) -> Result<Self, StartError> {
        #[cfg(feature = "sync-screen-wayland")]
        {
            use super::portal::{self, OpenError};
            match portal::open(grid, lost, on_event).await {
                Ok(cast) => Ok(ScreenSource { stop: Arc::default(), thread: None, _cast: Some(cast) }),
                Err(OpenError::Cancelled) => Err(StartError::Cancelled),
                Err(OpenError::Failed(e)) => Err(StartError::Failed(e)),
            }
        }
        #[cfg(not(feature = "sync-screen-wayland"))]
        {
            let _ = (grid, lost, on_event);
            Err(StartError::Failed("This build has no Wayland screen support.".into()))
        }
    }
}

/// Wayland: the screen the portal remembers (its size), if the next start
/// won't ask.
pub fn shared_screen() -> Option<SharedScreen> {
    #[cfg(feature = "sync-screen-wayland")]
    return super::portal::shared_screen().map(|(width, height)| SharedScreen { width, height });
    #[cfg(not(feature = "sync-screen-wayland"))]
    None
}

/// Wayland: "Change screen…" - the portal's dialog now; the answer is
/// remembered for the next start. Declining keeps the previous choice.
pub async fn pick_screen() -> Result<Option<SharedScreen>, StartError> {
    #[cfg(feature = "sync-screen-wayland")]
    {
        use super::portal::{self, OpenError};
        match portal::pick().await {
            Ok(_) => Ok(shared_screen()),
            Err(OpenError::Cancelled) => Err(StartError::Cancelled),
            Err(OpenError::Failed(e)) => Err(StartError::Failed(e)),
        }
    }
    #[cfg(not(feature = "sync-screen-wayland"))]
    Err(StartError::Failed("This build has no Wayland screen support.".into()))
}

/// A monitor shared through the portal, as far as it tells: its size.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SharedScreen {
    pub width: u32,
    pub height: u32,
}

pub fn monitors() -> Result<Vec<Monitor>, String> {
    #[cfg(feature = "sync-screen")]
    return x11::monitors();
    #[cfg(not(feature = "sync-screen"))]
    Err("This build has no screen support (feature sync-screen).".into())
}

/// Live check: capture the primary monitor for 1 s and print the grid's
/// average color. Run: `cargo test --lib live_screen -- --ignored --nocapture`
#[cfg(all(test, feature = "sync-screen"))]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_screen() {
        println!("monitors: {:?}", monitors());
        let grid = Arc::new(Mutex::new(None));
        let started = std::time::Instant::now();
        let source = ScreenSource::start(
            None,
            grid.clone(),
            Arc::new(AtomicBool::new(false)),
            Box::new(|event| println!("event: {event:?}")),
        )
        .expect("capture");
        std::thread::sleep(std::time::Duration::from_secs(1));
        let cells = grid.lock().unwrap().clone().expect("a frame").cells;
        let avg = cells.iter().fold([0.0; 3], |a, c| [a[0] + c[0], a[1] + c[1], a[2] + c[2]]).map(|v| v / cells.len() as f32);
        println!("average screen color (linear): {avg:?}");
        drop(source);
        println!("stopped cleanly after {} ms", started.elapsed().as_millis());
    }
}
