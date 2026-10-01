// Persistent settings, stored per XDG rather than next to the app so they
// survive updates. The file holds the application key - treat it as a secret
// (mode 600). The UI owns the JSON shape (src/store.ts); this is mostly I/O.

use std::fs::{self, DirBuilder, OpenOptions, Permissions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use serde::Deserialize;

fn config_path() -> PathBuf {
    crate::paths::config_dir().join("config.json")
}

/// The subset of settings the tray needs to talk to the bridge on its own.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSettings {
    pub bridge_ip: Option<String>,
    pub application_key: Option<String>,
    pub cert_fingerprint: Option<String>,
    /// PSK for the Entertainment (sync) stream; only present when pairing
    /// asked for it (`generateclientkey`).
    pub client_key: Option<String>,
}

pub fn read_bridge_settings() -> Option<BridgeSettings> {
    let raw = fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
pub fn load_config() -> Option<String> {
    fs::read_to_string(config_path()).ok()
}

#[tauri::command]
pub fn save_config(contents: String) -> Result<(), String> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| e.to_string())?;
    }

    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
    // `mode` only applies on creation - an existing file may have looser permissions.
    fs::set_permissions(&path, Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}
