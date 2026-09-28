// Hue Entertainment API: sync areas (REST), the stream packet format, and the
// DTLS connection that carries it.

pub mod api;
pub mod dtls;
pub mod protocol;

/// Live check against a real bridge (stage 0 spike, kept as a manual test):
/// streams a 5 s rainbow to the first sync area, then restores the lights.
/// Run: `cargo test --lib live_stream_rainbow -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};

    use super::api::BridgeAccess;
    use super::dtls::DtlsStream;
    use super::protocol::{encode, ChannelColor, ColorSpace};
    use crate::hue::{self, HueState};

    #[tokio::test]
    #[ignore]
    async fn live_stream_rainbow() {
        let settings = crate::config::read_bridge_settings().expect("config.json");
        let access = BridgeAccess {
            ip: settings.bridge_ip.expect("bridge ip"),
            key: settings.application_key.expect("application key"),
            pin: settings.cert_fingerprint,
        };
        let client_key = settings.client_key.expect("client key (pair with generateclientkey)");
        let state = HueState::default();

        let areas = access.areas(&state).await.expect("areas");
        let area = areas.first().expect("at least one sync area").clone();
        println!("area: {} ({} channels, status {})", area.name, area.channels.len(), area.status);

        // Snapshot the lights so the test leaves them as it found them.
        let headers = HashMap::from([("hue-application-key".to_string(), access.key.clone())]);
        let mut saved = Vec::new();
        for id in &area.light_ids {
            let res = hue::send_request(&state, &access.ip, "GET", &format!("/clip/v2/resource/light/{id}"), headers.clone(), None, access.pin.clone()).await.unwrap();
            let light: Value = serde_json::from_str::<Value>(&res.body).unwrap()["data"][0].clone();
            let mut restore = json!({ "on": light["on"], "dimming": { "brightness": light["dimming"]["brightness"] } });
            if light["color_temperature"]["mirek_valid"] == json!(true) {
                restore["color_temperature"] = json!({ "mirek": light["color_temperature"]["mirek"] });
            } else {
                restore["color"] = json!({ "xy": light["color"]["xy"] });
            }
            saved.push((id.clone(), restore));
        }

        access.set_streaming(&state, &area.id, true).await.expect("start");
        let started = Instant::now();
        let result = tokio::task::spawn_blocking({
            let (ip, key, area) = (access.ip.clone(), access.key.clone(), area.clone());
            move || -> Result<u32, String> {
                let mut stream = DtlsStream::connect(&ip, &key, &client_key)?;
                println!("DTLS connected in {:?}", started.elapsed());
                let mut sent = 0u32;
                let begin = Instant::now();
                while begin.elapsed() < Duration::from_secs(5) {
                    let t = begin.elapsed().as_secs_f32();
                    let channels: Vec<ChannelColor> = area
                        .channels
                        .iter()
                        .enumerate()
                        .map(|(i, c)| {
                            let hue = (t * 0.4 + i as f32 / area.channels.len() as f32) % 1.0;
                            let (r, g, b) = hue_to_rgb(hue);
                            ChannelColor::rgb(c.channel_id, r, g, b)
                        })
                        .collect();
                    stream.send(&encode(sent as u8, &area.id, ColorSpace::Rgb, &channels)?)?;
                    sent += 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                stream.close();
                Ok(sent)
            }
        })
        .await
        .unwrap();

        access.set_streaming(&state, &area.id, false).await.expect("stop");
        let mut put_headers = headers.clone();
        put_headers.insert("content-type".into(), "application/json".into());
        for (id, body) in saved {
            hue::send_request(&state, &access.ip, "PUT", &format!("/clip/v2/resource/light/{id}"), put_headers.clone(), Some(body.to_string()), access.pin.clone()).await.unwrap();
        }

        let sent = result.expect("stream");
        println!("sent {sent} packets in 5 s ({:.0}/s), lights restored", sent as f32 / 5.0);
        assert!(sent > 150);
    }

    fn hue_to_rgb(h: f32) -> (f32, f32, f32) {
        let x = 1.0 - ((h * 6.0) % 2.0 - 1.0).abs();
        match (h * 6.0) as u32 {
            0 => (1.0, x, 0.0),
            1 => (x, 1.0, 0.0),
            2 => (0.0, 1.0, x),
            3 => (0.0, x, 1.0),
            4 => (x, 0.0, 1.0),
            _ => (1.0, 0.0, x),
        }
    }
}
