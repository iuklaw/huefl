// The DTLS 1.2 connection that carries the stream (UDP port 2100).
//
// The bridge only speaks PSK: identity = the application key, key = the
// `clientkey` handed out at pairing (32 hex chars -> 16 bytes), cipher
// TLS_PSK_WITH_AES_128_GCM_SHA256. There is no certificate to verify - the
// PSK itself authenticates both sides.
//
// OpenSSL drives DTLS over any Read + Write, so a connected UDP socket is
// wrapped to map one write to one datagram.

use std::io::{self, Read, Write};
use std::net::UdpSocket;
use std::time::Duration;

use std::time::Instant;

use openssl::ssl::{ErrorCode, SslConnector, SslMethod, SslOptions, SslStream, SslVerifyMode};

pub const STREAM_PORT: u16 = 2100;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Short reads during the handshake, so a lost flight is resent quickly. The
/// bridge opens the port a moment after `action: start`; with one long read
/// the first ClientHello was lost and the handshake took the full timeout.
const RETRANSMIT_AFTER: Duration = Duration::from_millis(300);
const MTU: u32 = 1400;

/// A connected UDP socket as a stream: one write = one datagram.
#[derive(Debug)]
pub struct Datagrams(UdpSocket);

impl Read for Datagrams {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.recv(buf)
    }
}

impl Write for Datagrams {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.send(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub struct DtlsStream(SslStream<Datagrams>);

impl DtlsStream {
    pub fn connect(ip: &str, identity: &str, client_key_hex: &str) -> Result<Self, String> {
        let psk = decode_hex(client_key_hex)?;
        let identity = identity.as_bytes().to_vec();

        let mut builder = SslConnector::builder(SslMethod::dtls()).map_err(|e| e.to_string())?;
        builder
            .set_cipher_list("PSK-AES128-GCM-SHA256")
            .map_err(|e| e.to_string())?;
        builder.set_verify(SslVerifyMode::NONE);
        // The MTU is set explicitly below; asking the (wrapped) socket fails.
        builder.set_options(SslOptions::NO_QUERY_MTU);
        builder.set_psk_client_callback(move |_ssl, _hint, identity_out, psk_out| {
            // Identity as a NUL-terminated C string.
            if identity.len() + 1 > identity_out.len() || psk.len() > psk_out.len() {
                return Ok(0);
            }
            identity_out[..identity.len()].copy_from_slice(&identity);
            identity_out[identity.len()] = 0;
            psk_out[..psk.len()].copy_from_slice(&psk);
            Ok(psk.len())
        });
        let connector = builder.build();

        let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        socket
            .connect((ip, STREAM_PORT))
            .map_err(|e| format!("UDP {ip}:{STREAM_PORT}: {e}"))?;
        socket
            .set_read_timeout(Some(RETRANSMIT_AFTER))
            .map_err(|e| e.to_string())?;

        let mut config = connector.configure().map_err(|e| e.to_string())?;
        config.set_verify_hostname(false);
        config.set_use_server_name_indication(false);
        let mut ssl = config.into_ssl(ip).map_err(|e| e.to_string())?;
        ssl.set_mtu(MTU).map_err(|e| e.to_string())?;

        let mut stream = SslStream::new(ssl, Datagrams(socket)).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        loop {
            match stream.connect() {
                Ok(()) => return Ok(Self(stream)),
                // A read timed out: calling connect again makes OpenSSL resend
                // the last flight (its DTLS retransmission timer has expired).
                Err(e) if e.code() == ErrorCode::WANT_READ && Instant::now() < deadline => continue,
                Err(e) => {
                    return Err(format!(
                        "DTLS handshake with {ip}:{STREAM_PORT} failed \
                         (firewall/VPN blocking UDP, or wrong client key): {e}"
                    ))
                }
            }
        }
    }

    pub fn send(&mut self, packet: &[u8]) -> Result<(), String> {
        self.0.write_all(packet).map_err(|e| e.to_string())
    }

    pub fn close(mut self) {
        let _ = self.0.shutdown();
    }
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("client key has an odd number of hex digits".into());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| "client key is not hex".to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::decode_hex;

    #[test]
    fn hex_decoding() {
        assert_eq!(decode_hex("00ff10").unwrap(), vec![0x00, 0xFF, 0x10]);
        assert!(decode_hex("abc").is_err());
        assert!(decode_hex("zz").is_err());
    }
}
