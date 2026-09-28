// Transport to the Hue bridge: HTTPS with certificate pinning, and the event stream.
//
// The bridge certificate carries the bridge ID in the CN instead of a hostname,
// has no SAN, and the Signify root is not published anywhere — regular TLS
// verification cannot pass. Instead: TOFU as in SSH. On first connection the
// certificate's SHA-256 is stored (the TS side does that), and later
// connections compare against it. Handshake signature verification stays normal.
//
// The fingerprint uses the Bun/Node format (`AA:BB:...`), so a config.json
// saved by the Electrobun version keeps working without re-pairing.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::oneshot;

use crate::i18n::t_with;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

// --- Certificate verification ------------------------------------------------

fn fingerprint(cert: &[u8]) -> String {
    Sha256::digest(cert)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[derive(Debug)]
struct PinVerifier {
    /// The stored fingerprint, or None on first contact.
    expected: Option<String>,
    /// The fingerprint actually seen in the last handshake.
    seen: Arc<Mutex<Option<String>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity.as_ref());
        *self.seen.lock().unwrap() = Some(fp.clone());
        match &self.expected {
            Some(expected) if *expected != fp => {
                Err(rustls::Error::General("certificate fingerprint mismatch".into()))
            }
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

// --- Pinned client -----------------------------------------------------------

struct PinnedClient {
    http: reqwest::Client,
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl PinnedClient {
    fn new(expected: Option<String>) -> Result<Self, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let seen = Arc::new(Mutex::new(None));
        let verifier = PinVerifier {
            expected: expected.clone(),
            seen: seen.clone(),
            provider: provider.clone(),
        };

        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();

        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .connect_timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| describe(&e))?;

        Ok(Self { http, expected, seen })
    }

    fn seen(&self) -> Option<String> {
        self.seen.lock().unwrap().clone()
    }

    /// A readable message — a fingerprint mismatch instead of a generic TLS error.
    fn explain(&self, error: &reqwest::Error) -> String {
        if let (Some(expected), Some(seen)) = (&self.expected, self.seen()) {
            if *expected != seen {
                return t_with(
                    "error.cert_mismatch",
                    &[("expected", expected), ("seen", &seen)],
                );
            }
        }
        describe(error)
    }
}

/// The full error chain — `reqwest::Error` alone only says "error sending request".
fn describe(error: &dyn StdError) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    text
}

/// The bridge is addressed by IP only — this also limits where the webview can
/// send requests with standard TLS verification turned off.
fn base_url(ip: &str) -> Result<String, String> {
    match ip.trim().parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) => Ok(format!("https://{addr}")),
        Ok(IpAddr::V6(addr)) => Ok(format!("https://[{addr}]")),
        Err(_) => Err(t_with("error.invalid_ip", &[("ip", ip)])),
    }
}

#[derive(Default)]
pub struct HueState {
    /// Clients per (ip, pin) — so TLS is not set up from scratch for every command.
    clients: Mutex<HashMap<String, Arc<PinnedClient>>>,
    /// Open event streams: id -> stop signal.
    streams: Mutex<HashMap<u32, oneshot::Sender<()>>>,
}

impl HueState {
    fn client(&self, ip: &str, pin: Option<String>) -> Result<Arc<PinnedClient>, String> {
        let key = format!("{ip}|{}", pin.as_deref().unwrap_or(""));
        let mut clients = self.clients.lock().unwrap();
        if let Some(client) = clients.get(&key) {
            return Ok(client.clone());
        }
        let client = Arc::new(PinnedClient::new(pin)?);
        clients.insert(key, client.clone());
        Ok(client)
    }
}

// --- Commands ----------------------------------------------------------------

#[derive(Serialize)]
pub struct HueResponse {
    pub status: u16,
    pub body: String,
    fingerprint: Option<String>,
}

#[tauri::command]
pub async fn hue_request(
    state: State<'_, HueState>,
    ip: String,
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    pin: Option<String>,
) -> Result<HueResponse, String> {
    send_request(&state, &ip, &method, &path, headers, body, pin).await
}

/// A single request to the bridge — shared by the `hue_request` command and
/// the tray, which sends commands itself (see tray.rs).
pub async fn send_request(
    state: &HueState,
    ip: &str,
    method: &str,
    path: &str,
    headers: HashMap<String, String>,
    body: Option<String>,
    pin: Option<String>,
) -> Result<HueResponse, String> {
    let url = format!("{}{path}", base_url(ip)?);
    let client = state.client(ip, pin)?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;

    let mut request = client.http.request(method, url).timeout(REQUEST_TIMEOUT);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let response = request.send().await.map_err(|e| client.explain(&e))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| client.explain(&e))?;

    Ok(HueResponse {
        status,
        body,
        fingerprint: client.seen(),
    })
}

/// Stream messages — mirrors `StreamMessage` in src/hue/client.ts.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StreamMessage {
    Open,
    Data { payload: String },
}

/// One connection to `/eventstream/clip/v2` (SSE). Ends when the bridge closes
/// the stream or TS calls `hue_stream_close`. Reconnecting is up to TS.
#[tauri::command]
pub async fn hue_stream(
    state: State<'_, HueState>,
    id: u32,
    ip: String,
    key: String,
    pin: Option<String>,
    on_message: Channel<StreamMessage>,
) -> Result<(), String> {
    let url = format!("{}/eventstream/clip/v2", base_url(&ip)?);
    let client = state.client(&ip, pin)?;

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    state.streams.lock().unwrap().insert(id, stop_tx);

    let result: Result<(), String> = async {
        let mut response = tokio::select! {
            _ = &mut stop_rx => return Ok(()),
            response = client
                .http
                .get(url)
                .header("hue-application-key", &key)
                .header("accept", "text/event-stream")
                .send() => response.map_err(|e| client.explain(&e))?,
        };
        if !response.status().is_success() {
            return Err(format!("eventstream HTTP {}", response.status().as_u16()));
        }
        on_message.send(StreamMessage::Open).map_err(|e| e.to_string())?;

        // SSE frames are separated by a blank line. The buffer is bytes, since
        // a chunk may split a UTF-8 character in half.
        let mut buffer: Vec<u8> = Vec::new();
        loop {
            let chunk = tokio::select! {
                _ = &mut stop_rx => return Ok(()),
                chunk = response.chunk() => chunk.map_err(|e| client.explain(&e))?,
            };
            let Some(chunk) = chunk else { return Ok(()) };
            buffer.extend_from_slice(&chunk);

            while let Some(split) = buffer.windows(2).position(|w| w == b"\n\n") {
                let frame: Vec<u8> = buffer.drain(..split + 2).collect();
                let text = String::from_utf8_lossy(&frame[..split]);
                let payload: String = text
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(str::trim)
                    .collect();
                if !payload.is_empty() {
                    on_message
                        .send(StreamMessage::Data { payload })
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    .await;

    state.streams.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn hue_stream_close(state: State<'_, HueState>, id: u32) {
    if let Some(stop) = state.streams.lock().unwrap().remove(&id) {
        let _ = stop.send(());
    }
}

// --- Discovery ---------------------------------------------------------------

/// Raw output of `avahi-browse -rpt _hue._tcp`; TS does the parsing.
/// Empty when avahi is missing — TS then falls back to cloud discovery.
#[tauri::command]
pub async fn avahi_browse() -> String {
    let output = tokio::process::Command::new("avahi-browse")
        .args(["-rpt", "_hue._tcp"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();

    match tokio::time::timeout(Duration::from_secs(3), output).await {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    }
}

/// Signify's cloud endpoint — CORS would block it from the webview.
#[tauri::command]
pub async fn discover_cloud() -> Result<String, String> {
    let response = reqwest::Client::new()
        .get("https://discovery.meethue.com")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| describe(&e))?;
    if !response.status().is_success() {
        return Err(format!("discovery HTTP {}", response.status().as_u16()));
    }
    response.text().await.map_err(|e| describe(&e))
}

#[tauri::command]
pub fn device_name() -> String {
    std::env::var("USER").unwrap_or_else(|_| "linux".into())
}

