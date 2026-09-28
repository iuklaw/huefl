// What light sync needs, checked against the bridge — shown in the Sync tab as
// a checklist with a fix per item instead of a bare "Start" that fails.
//
// Pure: `facts` are gathered by the caller (sync/mod.rs), so every case is
// tested without a bridge. Messages live in the UI's i18n catalog under
// `sync.check.<id>.<level>`; `params` fill their placeholders.

use std::collections::BTreeMap;

use serde::Serialize;

use super::entertainment::api::Area;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Warning,
    /// Sync cannot start until this is fixed.
    Blocking,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub level: Level,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<&'static str, String>,
}

pub struct Facts<'a> {
    pub bridge_model: Option<&'a str>,
    /// e.g. "1.78.0"
    pub api_version: Option<&'a str>,
    pub has_client_key: bool,
    /// Lights that can take a stream.
    pub stream_lights: usize,
    pub areas: &'a [Area],
    /// An area someone else is streaming to right now.
    pub busy_area: Option<&'a str>,
}

/// CLIP v2 (which sync areas need) arrived with bridge API 1.48.
const MIN_API: (u32, u32) = (1, 48);

pub fn evaluate(facts: &Facts) -> Vec<Check> {
    let mut checks = Vec::new();
    let mut push = |id, level, params: &[(&'static str, String)]| {
        checks.push(Check { id, level, params: params.iter().cloned().collect() });
    };

    match facts.bridge_model {
        // The round first-generation bridge has no Entertainment API.
        Some("BSB001") => push("bridge", Level::Blocking, &[]),
        Some(_) => push("bridge", Level::Ok, &[]),
        None => push("bridge", Level::Warning, &[]),
    }

    match facts.api_version.and_then(parse_version) {
        Some(version) if version < MIN_API => {
            push("firmware", Level::Blocking, &[("version", facts.api_version.unwrap_or("").into())])
        }
        Some(_) => push("firmware", Level::Ok, &[]),
        None => push("firmware", Level::Warning, &[]),
    }

    push("client_key", if facts.has_client_key { Level::Ok } else { Level::Blocking }, &[]);

    let count = facts.stream_lights.to_string();
    let level = if facts.stream_lights == 0 { Level::Blocking } else { Level::Ok };
    push("lights", level, &[("count", count)]);

    let count = facts.areas.len().to_string();
    let level = if facts.areas.is_empty() { Level::Blocking } else { Level::Ok };
    push("area", level, &[("count", count)]);

    match facts.busy_area {
        // Not blocking: the user can take over.
        Some(name) => push("bridge_free", Level::Warning, &[("area", name.into())]),
        None => push("bridge_free", Level::Ok, &[]),
    }

    checks
}

pub fn is_ready(checks: &[Check]) -> bool {
    checks.iter().all(|c| c.level != Level::Blocking)
}

fn parse_version(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> Area {
        Area {
            id: "a".into(),
            name: "Gaming desk".into(),
            kind: "monitor".into(),
            status: "inactive".into(),
            channels: vec![],
            light_ids: vec![],
            members: vec![],
        }
    }

    fn level(checks: &[Check], id: &str) -> Level {
        checks.iter().find(|c| c.id == id).unwrap().level
    }

    #[test]
    fn development_bridge_is_ready() {
        let areas = [area()];
        let checks = evaluate(&Facts {
            bridge_model: Some("BSB002"),
            api_version: Some("1.78.0"),
            has_client_key: true,
            stream_lights: 3,
            areas: &areas,
            busy_area: None,
        });
        assert!(is_ready(&checks), "{checks:?}");
    }

    #[test]
    fn blocking_cases() {
        let checks = evaluate(&Facts {
            bridge_model: Some("BSB001"),
            api_version: Some("1.41.0"),
            has_client_key: false,
            stream_lights: 0,
            areas: &[],
            busy_area: None,
        });
        for id in ["bridge", "firmware", "client_key", "lights", "area"] {
            assert_eq!(level(&checks, id), Level::Blocking, "{id}");
        }
        assert!(!is_ready(&checks));
    }

    #[test]
    fn busy_bridge_warns_but_allows_take_over() {
        let areas = [area()];
        let checks = evaluate(&Facts {
            bridge_model: Some("BSB002"),
            api_version: Some("1.78.0"),
            has_client_key: true,
            stream_lights: 3,
            areas: &areas,
            busy_area: Some("TV"),
        });
        assert_eq!(level(&checks, "bridge_free"), Level::Warning);
        assert_eq!(checks.last().unwrap().params["area"], "TV");
        assert!(is_ready(&checks));
    }
}
