// Bug reports: what the "Report a bug" form in About gathers and where it goes.
//
// The UI owns the report's shape (BugReport in src/types.ts) and shows the
// user exactly what will be sent; Rust supplies the parts the webview can't
// see (system facts, the log), strips secrets, and sends it: an HTTP POST of
// the report as JSON to HUEFL_REPORT_URL, set when building
// (`HUEFL_REPORT_URL=https://… npm run tauri build`), with an optional
// `Authorization: Bearer $HUEFL_REPORT_TOKEN`. The server answers
// `{"id": "…"}`. A build without the URL answers `not_configured`.
//
// Secrets: the bridge key and the stream key are removed by value from
// everything that leaves the app — logs name fields freely, and a key can
// hide inside a URL (a schedule's command address, for one).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::logs::{self, LogStore};

/// Upper bound for a whole report, after serializing: the whole log (two
/// files of up to 1 MB) plus the rest, with room to spare.
const MAX_REPORT_BYTES: usize = 5 * 1024 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
const REDACTED: &str = "[redacted]";

/// Where reports go in this build.
enum Transport {
    Http { url: &'static str, token: Option<&'static str> },
    NotConfigured,
}

impl Transport {
    fn from_build() -> Self {
        match option_env!("HUEFL_REPORT_URL") {
            Some(url) if !url.is_empty() => Transport::Http { url, token: option_env!("HUEFL_REPORT_TOKEN") },
            _ => Transport::NotConfigured,
        }
    }

    /// Delivers the JSON body; returns the report's id on the receiving side.
    async fn send(&self, body: String) -> Result<String, String> {
        let Transport::Http { url, token } = self else {
            return Err("not_configured".into());
        };
        let client = reqwest::Client::builder().timeout(SEND_TIMEOUT).build().map_err(|e| e.to_string())?;
        let mut request = client.post(*url).header("content-type", "application/json").body(body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|e| format!("Couldn't reach the report server: {e}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("The report server answered {status}"));
        }
        #[derive(Deserialize)]
        struct Accepted {
            id: Option<String>,
        }
        Ok(serde_json::from_str::<Accepted>(&text).ok().and_then(|a| a.id).unwrap_or_default())
    }
}

/// Facts about this machine that help reproduce a bug — nothing that
/// identifies the person (no host or user name).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    os: Option<String>,
    kernel: Option<String>,
    arch: &'static str,
    desktop: Option<String>,
    session_type: Option<String>,
    locale: Option<String>,
    audio_server: Option<String>,
    features: Vec<&'static str>,
}

#[tauri::command]
pub fn bug_report_system_info() -> SystemInfo {
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let mut features = Vec::new();
    if cfg!(feature = "sync-audio") {
        features.push("sync-audio");
    }
    if cfg!(feature = "sync-screen") {
        features.push("sync-screen");
    }
    SystemInfo {
        os: std::fs::read_to_string("/etc/os-release").ok().and_then(|text| os_name(&text)),
        kernel: std::fs::read_to_string("/proc/sys/kernel/osrelease").ok().map(|k| k.trim().to_string()),
        arch: std::env::consts::ARCH,
        desktop: env("XDG_CURRENT_DESKTOP"),
        session_type: env("XDG_SESSION_TYPE"),
        locale: env("LC_ALL").or_else(|| env("LANG")),
        audio_server: crate::sync::audio::devices::default_devices().ok().and_then(|d| d.server),
        features,
    }
}

/// The whole log on disk, oldest first, with secrets removed — a bug often
/// starts well before the moment it's reported.
#[tauri::command]
pub fn bug_report_logs(store: State<'_, LogStore>) -> Vec<Value> {
    scrub(&logs::read_all(&store), &secrets())
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Sends the report; returns its id on the server.
#[tauri::command]
pub async fn bug_report_send(app: tauri::AppHandle, report: Value) -> Result<String, String> {
    let body = prepare(&report)?;
    match Transport::from_build().send(body).await {
        Ok(id) => {
            logs::write(&app, "info", "app", "report.sent", "Bug report sent", Some(serde_json::json!({ "id": id })));
            Ok(id)
        }
        Err(e) => {
            if e != "not_configured" {
                logs::write(&app, "warn", "app", "report.failed", e.clone(), None);
            }
            Err(e)
        }
    }
}

/// Serialized, scrubbed and within the size limit.
fn prepare(report: &Value) -> Result<String, String> {
    let json = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    let json = scrub(&json, &secrets());
    if json.len() > MAX_REPORT_BYTES {
        return Err(format!("The report is too large ({} KB, at most {} KB).", json.len() / 1024, MAX_REPORT_BYTES / 1024));
    }
    Ok(json)
}

/// The bridge's application key and stream key: never part of a report.
fn secrets() -> Vec<String> {
    crate::config::read_bridge_settings()
        .map(|s| [s.application_key, s.client_key].into_iter().flatten().collect())
        .unwrap_or_default()
}

/// Replaces every occurrence of each secret. Short values are skipped — they
/// can't be keys, and replacing them would mangle ordinary text.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    secrets
        .iter()
        .filter(|s| s.len() >= 8)
        .fold(text.to_string(), |text, secret| text.replace(secret.as_str(), REDACTED))
}

/// PRETTY_NAME from /etc/os-release ("Ubuntu 22.04.5 LTS").
fn os_name(os_release: &str) -> Option<String> {
    os_release
        .lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim_matches('"').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_removes_keys_wherever_they_hide() {
        let key = "TEST-KEY-not-a-real-bridge-key-012345678".to_string();
        let text = format!(r#"{{"body":{{"command":{{"address":"/api/{key}/groups/81/action"}}}},"k":"{key}"}}"#);
        let clean = scrub(&text, std::slice::from_ref(&key));
        assert!(!clean.contains(&key), "{clean}");
        assert_eq!(clean.matches(REDACTED).count(), 2);
    }

    #[test]
    fn scrub_ignores_short_values() {
        assert_eq!(scrub("on at 80", &["80".into()]), "on at 80");
    }

    #[test]
    fn reads_the_os_name() {
        let text = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 22.04.5 LTS\"\nID=ubuntu\n";
        assert_eq!(os_name(text).as_deref(), Some("Ubuntu 22.04.5 LTS"));
    }

    #[tokio::test]
    async fn http_transport_posts_json_and_reads_the_id() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url: &'static str = Box::leak(format!("http://{}/reports", listener.local_addr().unwrap()).into_boxed_str());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            // Headers, then the body by Content-Length.
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                let n = socket.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
            }
            let text = String::from_utf8_lossy(&request).to_string();
            let length: usize = text
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .unwrap();
            let head = text.find("\r\n\r\n").unwrap() + 4;
            while request.len() < head + length {
                let n = socket.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
            }
            let reply = r#"{"id":"R-42"}"#;
            write!(socket, "HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}", reply.len()).unwrap();
            String::from_utf8_lossy(&request).to_string()
        });

        let transport = Transport::Http { url, token: Some("secret-token") };
        let id = transport.send(r#"{"schema":1,"description":"lights flicker"}"#.into()).await.unwrap();
        let request = server.join().unwrap();

        assert_eq!(id, "R-42");
        assert!(request.starts_with("POST /reports "), "{request}");
        assert!(request.to_ascii_lowercase().contains("authorization: bearer secret-token"), "{request}");
        assert!(request.ends_with(r#"{"schema":1,"description":"lights flicker"}"#), "{request}");
    }

    #[tokio::test]
    async fn without_a_url_nothing_is_sent() {
        assert_eq!(Transport::NotConfigured.send("{}".into()).await.unwrap_err(), "not_configured");
    }

    /// Live: what this machine reports. `cargo test --lib live_system_info -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_system_info() {
        println!("{}", serde_json::to_string_pretty(&bug_report_system_info()).unwrap());
    }
}
