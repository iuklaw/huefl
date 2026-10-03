// Transport to the Hue bridge: HTTPS with certificate pinning, and the event stream.
//
// The bridge certificate carries the bridge ID in the CN instead of a hostname,
// has no SAN, and the Signify root is not published anywhere - regular TLS
// verification cannot pass. Instead: TOFU as in SSH. On first connection the
// certificate's SHA-256 is stored (the TS side does that), and later
// connections compare against it. Handshake signature verification stays normal.
//
// The fingerprint uses the Bun/Node format (`AA:BB:...`), so a config.json
// saved by the Electrobun version keeps working without re-pairing.

use std::collections::{BTreeMap, HashMap};
use std::error::Error as StdError;
use std::net::{IpAddr, Ipv4Addr};
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

    /// A readable message - a fingerprint mismatch instead of a generic TLS error.
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

/// The full error chain - `reqwest::Error` alone only says "error sending request".
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

/// The bridge is addressed by IP only - this also limits where the webview can
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
    /// Clients per (ip, pin) - so TLS is not set up from scratch for every command.
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

/// A single request to the bridge - shared by the `hue_request` command and
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

/// Stream messages - mirrors `StreamMessage` in src/hue/client.ts.
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

const MDNS_SERVICE: &str = "_hue._tcp.local.";
/// How long to listen for bridges at most...
const MDNS_WAIT: Duration = Duration::from_secs(3);
/// ...and after the first one answered (others on the network answer together).
const MDNS_AFTER_FIRST: Duration = Duration::from_secs(1);

/// A bridge that answered on the local network.
#[derive(Debug, PartialEq, Serialize)]
pub struct FoundBridge {
    id: String,
    ip: String,
}

/// Bridges on the local network, through mDNS done in-process: no avahi
/// daemon or tools needed (a Flatpak has neither). IPv4 only - the sync
/// stream is IPv4-only, and a link-local IPv6 address needs its interface.
#[tauri::command]
pub async fn discover_mdns() -> Result<Vec<FoundBridge>, String> {
    tauri::async_runtime::spawn_blocking(browse_mdns).await.map_err(|e| e.to_string())?
}

fn browse_mdns() -> Result<Vec<FoundBridge>, String> {
    use mdns_sd::{IfKind, ServiceDaemon, ServiceEvent};

    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS: {e}"))?;
    for kind in [IfKind::IPv6, IfKind::LoopbackV4, IfKind::LoopbackV6] {
        let _ = daemon.disable_interface(kind);
    }
    let events = daemon.browse(MDNS_SERVICE).map_err(|e| format!("mDNS: {e}"))?;

    let started = std::time::Instant::now();
    let mut deadline = started + MDNS_WAIT;
    let mut found = Vec::new();
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        match events.recv_timeout(left) {
            Ok(ServiceEvent::ServiceResolved(service)) => {
                if found.is_empty() {
                    deadline = deadline.min(std::time::Instant::now() + MDNS_AFTER_FIRST);
                }
                let id = service.get_property_val_str("bridgeid").map(str::to_string);
                found.push((id, service.get_addresses_v4().into_iter().collect()));
            }
            Ok(_) => {}
            Err(_) => break, // timed out, or the daemon is gone
        }
    }
    let _ = daemon.shutdown();
    Ok(collect_bridges(found))
}

/// One entry per bridge - it answers once per interface - by its bridge ID
/// (the IP when it gives none), with its lowest address, sorted by ID.
fn collect_bridges(found: impl IntoIterator<Item = (Option<String>, Vec<Ipv4Addr>)>) -> Vec<FoundBridge> {
    let mut bridges: BTreeMap<String, Ipv4Addr> = BTreeMap::new();
    for (id, addresses) in found {
        let Some(ip) = addresses.into_iter().min() else { continue };
        let id = id.map(|id| id.to_lowercase()).unwrap_or_else(|| ip.to_string());
        bridges.entry(id).and_modify(|known| *known = (*known).min(ip)).or_insert(ip);
    }
    bridges.into_iter().map(|(id, ip)| FoundBridge { id, ip: ip.to_string() }).collect()
}

/// Signify's cloud endpoint - CORS would block it from the webview.
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


#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn a_bridge_answering_on_several_interfaces_is_listed_once() {
        let found = vec![
            (Some("ECB5FAFFFEBE035E".to_string()), vec![ip("192.168.10.233")]),
            (Some("ecb5fafffebe035e".to_string()), vec![ip("192.168.20.5"), ip("192.168.10.233")]),
        ];
        assert_eq!(
            collect_bridges(found),
            vec![FoundBridge { id: "ecb5fafffebe035e".into(), ip: "192.168.10.233".into() }]
        );
    }

    #[test]
    fn different_bridges_stay_apart_sorted_by_id() {
        let found = vec![
            (Some("bbbb".to_string()), vec![ip("192.168.1.3")]),
            (Some("aaaa".to_string()), vec![ip("192.168.1.2")]),
        ];
        let ids: Vec<_> = collect_bridges(found).into_iter().map(|b| b.id).collect();
        assert_eq!(ids, ["aaaa", "bbbb"]);
    }

    #[test]
    fn without_a_bridge_id_the_ip_stands_in_and_no_address_means_no_entry() {
        let found = vec![(None, vec![ip("10.0.0.7")]), (Some("cccc".to_string()), vec![])];
        assert_eq!(collect_bridges(found), vec![FoundBridge { id: "10.0.0.7".into(), ip: "10.0.0.7".into() }]);
    }

    /// Real network: `cargo test --lib live_discover -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_discover() {
        let started = std::time::Instant::now();
        let bridges = browse_mdns().unwrap();
        println!("{bridges:?} in {} ms", started.elapsed().as_millis());
        assert!(!bridges.is_empty(), "no bridge answered");
    }
}
