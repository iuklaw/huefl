// Application log: recent actions and events, for the user (Options → Logs)
// and for debugging.
//
// Rust owns the log rather than the webview: JS is suspended while the window
// is hidden, tray actions happen only here, and the history has to survive a
// restart. Entries from JS arrive in batches through `log_write`.
//
// Storage: a ring buffer of the last MAX_ENTRIES in memory, plus JSON Lines in
// $XDG_STATE_HOME/huefl/huefl.log (mode 600), rotated to `.log.1` at
// MAX_FILE_BYTES. The buffer is seeded from the file on start, so the previous
// session is visible too. Every new entry is emitted to the UI as "log-entry".
//
// Never log secrets: the TS logger redacts keys; Rust callers must not pass them.

use std::collections::VecDeque;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_ENTRIES: usize = 1000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    /// Milliseconds since the Unix epoch.
    pub ts: f64,
    pub level: String,
    pub source: String,
    pub event: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

pub struct LogStore {
    path: PathBuf,
    ring: Mutex<VecDeque<Entry>>,
    file: Mutex<Option<File>>,
}

fn default_log_path() -> PathBuf {
    crate::paths::state_dir().join(crate::paths::LOG_FILE)
}

fn open_log(path: &PathBuf) -> Option<File> {
    if let Some(dir) = path.parent() {
        DirBuilder::new().recursive(true).mode(0o700).create(dir).ok()?;
    }
    OpenOptions::new().create(true).append(true).mode(0o600).open(path).ok()
}

/// The last MAX_ENTRIES valid lines of the current log file.
fn read_tail(path: &PathBuf) -> VecDeque<Entry> {
    let Ok(text) = fs::read_to_string(path) else {
        return VecDeque::new();
    };
    let mut entries: VecDeque<Entry> = text
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str(line).ok())
        .take(MAX_ENTRIES)
        .collect();
    entries.make_contiguous().reverse();
    entries
}

pub fn init(app: &AppHandle) {
    let path = default_log_path();
    let store = LogStore {
        ring: Mutex::new(read_tail(&path)),
        file: Mutex::new(open_log(&path)),
        path,
    };
    app.manage(store);
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

impl LogStore {
    fn append(&self, entry: &Entry) {
        {
            let mut ring = self.ring.lock().unwrap();
            if ring.len() == MAX_ENTRIES {
                ring.pop_front();
            }
            ring.push_back(entry.clone());
        }

        let mut file = self.file.lock().unwrap();
        if let (Some(handle), Ok(line)) = (file.as_mut(), serde_json::to_string(entry)) {
            let _ = writeln!(handle, "{line}");
            let too_big = handle.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(false);
            if too_big {
                *file = None;
                let _ = fs::rename(&self.path, self.path.with_extension("log.1"));
                *file = open_log(&self.path);
            }
        }
    }
}

fn publish(app: &AppHandle, entry: Entry) {
    if cfg!(debug_assertions) {
        eprintln!(
            "[{}] {} {}: {}{}",
            entry.level,
            entry.source,
            entry.event,
            entry.message,
            entry.data.as_ref().map(|d| format!(" {d}")).unwrap_or_default()
        );
    }
    if let Some(store) = app.try_state::<LogStore>() {
        store.append(&entry);
    }
    let _ = app.emit("log-entry", entry);
}

/// Logs from Rust. `level`: "debug" | "info" | "warn" | "error".
pub fn write(
    app: &AppHandle,
    level: &str,
    source: &str,
    event: &str,
    message: impl Into<String>,
    data: Option<Value>,
) {
    publish(
        app,
        Entry {
            ts: now_ms(),
            level: level.into(),
            source: source.into(),
            event: event.into(),
            message: message.into(),
            data,
        },
    );
}

// --- Commands ----------------------------------------------------------------

/// A batch from the TS logger (src/core/log.ts); timestamps are set there.
#[tauri::command]
pub fn log_write(app: AppHandle, entries: Vec<Entry>) {
    for entry in entries {
        publish(&app, entry);
    }
}

#[tauri::command]
pub fn log_read(store: State<'_, LogStore>) -> Vec<Entry> {
    store.ring.lock().unwrap().iter().cloned().collect()
}

/// Everything on disk, oldest first: the rotated file, then the current one
/// (JSON lines; up to ~2 × MAX_FILE_BYTES). For bug reports.
pub fn read_all(store: &LogStore) -> String {
    let _writing = store.file.lock().unwrap(); // not mid-rotation
    [store.path.with_extension("log.1"), store.path.clone()]
        .iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub fn log_clear(store: State<'_, LogStore>) -> Result<(), String> {
    store.ring.lock().unwrap().clear();
    let mut file = store.file.lock().unwrap();
    *file = None;
    let _ = fs::remove_file(store.path.with_extension("log.1"));
    fs::write(&store.path, b"").map_err(|e| e.to_string())?;
    *file = open_log(&store.path);
    Ok(())
}

#[tauri::command]
pub fn log_path(store: State<'_, LogStore>) -> String {
    store.path.display().to_string()
}
