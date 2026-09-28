// REST side of the Entertainment API: the bridge's sync areas
// (`entertainment_configuration`), which lights can stream (`entertainment`
// services), and starting/stopping a stream.
//
// Goes through hue::send_request, so the pinned bridge certificate applies.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hue::{self, HueState};

/// Bridge address and credentials, read from config.json.
#[derive(Clone)]
pub struct BridgeAccess {
    pub ip: String,
    pub key: String,
    pub pin: Option<String>,
}

impl BridgeAccess {
    async fn request(
        &self,
        state: &HueState,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut headers = HashMap::from([("hue-application-key".to_string(), self.key.clone())]);
        if body.is_some() {
            headers.insert("content-type".into(), "application/json".into());
        }
        let res = hue::send_request(
            state,
            &self.ip,
            method,
            path,
            headers,
            body.map(|b| b.to_string()),
            self.pin.clone(),
        )
        .await?;
        let json: Value = serde_json::from_str(&res.body)
            .map_err(|_| format!("{method} {path}: HTTP {} (not JSON)", res.status))?;
        if let Some(errors) = json.get("errors").and_then(Value::as_array) {
            if !errors.is_empty() {
                let text: Vec<&str> = errors.iter().filter_map(|e| e["description"].as_str()).collect();
                return Err(format!("{method} {path}: {}", text.join("; ")));
            }
        }
        if res.status >= 400 {
            return Err(format!("{method} {path}: HTTP {}", res.status));
        }
        Ok(json["data"].clone())
    }

    pub async fn areas(&self, state: &HueState) -> Result<Vec<Area>, String> {
        let data = self
            .request(state, "GET", "/clip/v2/resource/entertainment_configuration", None)
            .await?;
        parse_areas(&data)
    }

    pub async fn set_streaming(&self, state: &HueState, area_id: &str, start: bool) -> Result<(), String> {
        let action = if start { "start" } else { "stop" };
        self.request(
            state,
            "PUT",
            &format!("/clip/v2/resource/entertainment_configuration/{area_id}"),
            Some(json!({ "action": action })),
        )
        .await
        .map(|_| ())
    }

    /// Model and API version from the unauthenticated `/api/config`.
    pub async fn bridge_facts(&self, state: &HueState) -> Result<(Option<String>, Option<String>), String> {
        let res = hue::send_request(state, &self.ip, "GET", "/api/config", HashMap::new(), None, self.pin.clone()).await?;
        let config: Value = serde_json::from_str(&res.body).map_err(|e| e.to_string())?;
        Ok((
            config["modelid"].as_str().map(String::from),
            config["apiversion"].as_str().map(String::from),
        ))
    }

    /// Every light with whether it can stream, and its entertainment service
    /// (what a sync area references instead of the light itself).
    pub async fn sync_lights(&self, state: &HueState) -> Result<Vec<SyncLight>, String> {
        let lights = self.request(state, "GET", "/clip/v2/resource/light", None).await?;
        let services = self.request(state, "GET", "/clip/v2/resource/entertainment", None).await?;
        Ok(match_sync_lights(&lights, &services))
    }

    /// Current on/brightness/color of lights, as PUT bodies that restore it.
    pub async fn light_snapshot(&self, state: &HueState, light_ids: &[String]) -> Result<Vec<(String, Value)>, String> {
        let mut saved = Vec::new();
        for id in light_ids {
            let data = self.request(state, "GET", &format!("/clip/v2/resource/light/{id}"), None).await?;
            saved.push((id.clone(), restore_body(&data[0])));
        }
        Ok(saved)
    }

    pub async fn restore_lights(&self, state: &HueState, saved: &[(String, Value)]) -> Result<(), String> {
        for (id, body) in saved {
            self.request(state, "PUT", &format!("/clip/v2/resource/light/{id}"), Some(body.clone()))
                .await?;
        }
        Ok(())
    }

    pub async fn create_area(&self, state: &HueState, draft: &AreaDraft) -> Result<String, String> {
        let data = self
            .request(state, "POST", "/clip/v2/resource/entertainment_configuration", Some(draft.to_body(true)))
            .await?;
        data[0]["rid"].as_str().map(String::from).ok_or_else(|| "bridge returned no id".to_string())
    }

    pub async fn update_area(&self, state: &HueState, id: &str, draft: &AreaDraft) -> Result<(), String> {
        self.request(
            state,
            "PUT",
            &format!("/clip/v2/resource/entertainment_configuration/{id}"),
            Some(draft.to_body(false)),
        )
        .await
        .map(|_| ())
    }

    pub async fn delete_area(&self, state: &HueState, id: &str) -> Result<(), String> {
        self.request(state, "DELETE", &format!("/clip/v2/resource/entertainment_configuration/{id}"), None)
            .await
            .map(|_| ())
    }
}

/// A light as the sync setup sees it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLight {
    pub light_id: String,
    /// The light's `entertainment` service — what an area lists.
    pub service_id: Option<String>,
    /// Whether it can take a stream (color light with recent firmware).
    pub renderer: bool,
}

/// Lights and entertainment services both belong to the device; join on it.
pub fn match_sync_lights(lights: &Value, services: &Value) -> Vec<SyncLight> {
    let by_device: HashMap<&str, (&str, bool)> = services
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some((
                s["owner"]["rid"].as_str()?,
                (s["id"].as_str()?, s["renderer"].as_bool().unwrap_or(false)),
            ))
        })
        .collect();
    lights
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let service = l["owner"]["rid"].as_str().and_then(|d| by_device.get(d));
            Some(SyncLight {
                light_id: l["id"].as_str()?.to_string(),
                service_id: service.map(|(id, _)| id.to_string()),
                renderer: service.map(|(_, r)| *r).unwrap_or(false),
            })
        })
        .collect()
}

/// PUT body that brings a light back to the state in `light` (a GET result).
pub fn restore_body(light: &Value) -> Value {
    let mut body = json!({ "on": { "on": light["on"]["on"] } });
    if let Some(brightness) = light["dimming"]["brightness"].as_f64() {
        body["dimming"] = json!({ "brightness": brightness });
    }
    if light["color_temperature"]["mirek_valid"] == json!(true) {
        body["color_temperature"] = json!({ "mirek": light["color_temperature"]["mirek"] });
    } else if light["color"]["xy"].is_object() {
        body["color"] = json!({ "xy": light["color"]["xy"] });
    }
    body
}

/// What the UI sends to create or edit an area.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaDraft {
    pub name: String,
    /// "music" | "screen" | "monitor"
    pub kind: String,
    pub members: Vec<AreaMember>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaMember {
    pub service_id: String,
    pub position: Position,
}

impl AreaDraft {
    fn to_body(&self, create: bool) -> Value {
        let mut body = json!({
            "metadata": { "name": self.name },
            "configuration_type": self.kind,
            "locations": {
                "service_locations": self.members.iter().map(|m| json!({
                    "service": { "rid": m.service_id, "rtype": "entertainment" },
                    "positions": [m.position],
                })).collect::<Vec<_>>()
            }
        });
        if create {
            body["type"] = json!("entertainment_configuration");
        }
        body
    }
}

// --- Model -------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaChannel {
    pub channel_id: u8,
    pub position: Position,
}

/// A sync area as the app uses it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    pub id: String,
    pub name: String,
    /// "screen" | "monitor" | "music" | "3dspace" | "other"
    pub kind: String,
    /// "active" while someone streams to it
    pub status: String,
    pub channels: Vec<AreaChannel>,
    /// `light` resource ids in the area
    pub light_ids: Vec<String>,
    /// Which lights sit where, by entertainment service (for editing).
    pub members: Vec<AreaMemberView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaMemberView {
    pub service_id: String,
    pub position: Position,
}

#[derive(Deserialize)]
struct RawRef {
    rid: String,
}

#[derive(Deserialize)]
struct RawChannel {
    channel_id: u8,
    position: Position,
}

#[derive(Deserialize)]
struct RawLocation {
    service: RawRef,
    #[serde(default)]
    positions: Vec<Position>,
}

#[derive(Deserialize, Default)]
struct RawLocations {
    #[serde(default)]
    service_locations: Vec<RawLocation>,
}

#[derive(Deserialize)]
struct RawArea {
    #[serde(default)]
    locations: RawLocations,
    id: String,
    metadata: Option<RawName>,
    configuration_type: Option<String>,
    status: Option<String>,
    #[serde(default)]
    channels: Vec<RawChannel>,
    #[serde(default)]
    light_services: Vec<RawRef>,
}

#[derive(Deserialize)]
struct RawName {
    name: Option<String>,
}

pub fn parse_areas(data: &Value) -> Result<Vec<Area>, String> {
    let raw: Vec<RawArea> =
        serde_json::from_value(data.clone()).map_err(|e| format!("unexpected sync area format: {e}"))?;
    Ok(raw
        .into_iter()
        .map(|a| Area {
            id: a.id,
            name: a.metadata.and_then(|m| m.name).unwrap_or_default(),
            kind: a.configuration_type.unwrap_or_else(|| "other".into()),
            status: a.status.unwrap_or_else(|| "inactive".into()),
            channels: a
                .channels
                .into_iter()
                .map(|c| AreaChannel { channel_id: c.channel_id, position: c.position })
                .collect(),
            light_ids: a.light_services.into_iter().map(|r| r.rid).collect(),
            members: a
                .locations
                .service_locations
                .into_iter()
                .filter_map(|l| {
                    Some(AreaMemberView { service_id: l.service.rid, position: *l.positions.first()? })
                })
                .collect(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bridge_areas() {
        // Shape of the "Gaming desk" area on the development bridge.
        let data = json!([{
            "id": "1a8d99cc-967b-44f2-9202-43f976c0fa6b",
            "type": "entertainment_configuration",
            "metadata": { "name": "Gaming desk" },
            "configuration_type": "monitor",
            "status": "inactive",
            "channels": [
                { "channel_id": 0, "position": { "x": 0.46, "y": 1.0, "z": -0.33 }, "members": [] },
                { "channel_id": 1, "position": { "x": -0.53, "y": 1.0, "z": -0.56 }, "members": [] }
            ],
            "light_services": [{ "rtype": "light", "rid": "4004c6fc" }, { "rtype": "light", "rid": "f7a1f52d" }]
        }]);
        let areas = parse_areas(&data).unwrap();
        assert_eq!(areas.len(), 1);
        assert_eq!(areas[0].name, "Gaming desk");
        assert_eq!(areas[0].kind, "monitor");
        assert_eq!(areas[0].channels[1].channel_id, 1);
        assert_eq!(areas[0].channels[1].position.x, -0.53);
        assert_eq!(areas[0].light_ids, vec!["4004c6fc", "f7a1f52d"]);
    }

    #[test]
    fn joins_lights_with_entertainment_services() {
        let lights = json!([
            { "id": "light-a", "owner": { "rid": "dev-a" } },
            { "id": "light-b", "owner": { "rid": "dev-b" } },
            { "id": "light-c", "owner": { "rid": "dev-c" } }
        ]);
        let services = json!([
            { "id": "ent-a", "owner": { "rid": "dev-a" }, "renderer": true },
            { "id": "ent-b", "owner": { "rid": "dev-b" }, "renderer": false },
            { "id": "ent-bridge", "owner": { "rid": "bridge" }, "renderer": false }
        ]);
        let joined = match_sync_lights(&lights, &services);
        assert_eq!(joined[0], SyncLight { light_id: "light-a".into(), service_id: Some("ent-a".into()), renderer: true });
        assert!(!joined[1].renderer);
        assert_eq!(joined[2].service_id, None);
    }

    #[test]
    fn restore_body_keeps_the_active_mode() {
        let color = json!({ "on": { "on": true }, "dimming": { "brightness": 40.0 },
            "color": { "xy": { "x": 0.3, "y": 0.4 } }, "color_temperature": { "mirek": null, "mirek_valid": false } });
        assert_eq!(restore_body(&color), json!({ "on": { "on": true }, "dimming": { "brightness": 40.0 }, "color": { "xy": { "x": 0.3, "y": 0.4 } } }));
        let white = json!({ "on": { "on": false }, "dimming": { "brightness": 10.0 },
            "color": { "xy": { "x": 0.3, "y": 0.4 } }, "color_temperature": { "mirek": 366, "mirek_valid": true } });
        assert_eq!(restore_body(&white)["color_temperature"], json!({ "mirek": 366 }));
        assert!(restore_body(&white).get("color").is_none());
    }

    #[test]
    fn draft_body_matches_bridge_format() {
        let draft = AreaDraft {
            name: "Hue Tray – Music".into(),
            kind: "music".into(),
            members: vec![AreaMember { service_id: "ent-a".into(), position: Position { x: -0.5, y: 0.8, z: 0.0 } }],
        };
        let body = draft.to_body(true);
        assert_eq!(body["type"], "entertainment_configuration");
        assert_eq!(body["locations"]["service_locations"][0]["service"], json!({ "rid": "ent-a", "rtype": "entertainment" }));
        assert_eq!(body["locations"]["service_locations"][0]["positions"][0]["x"], -0.5);
        assert!(draft.to_body(false).get("type").is_none());
    }
}
