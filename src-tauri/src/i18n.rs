// Translations for texts produced on the Rust side (tray menu, errors).
//
// Uses the same catalog as the UI (src/locales/*.json), embedded at compile
// time. Only English exists for now; when more languages are added, the UI
// can pass its resolved locale to Rust and `catalog()` can pick accordingly.

use std::collections::HashMap;
use std::sync::OnceLock;

fn catalog() -> &'static HashMap<String, String> {
    static CATALOG: OnceLock<HashMap<String, String>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/locales/en.json"))
            .expect("src/locales/en.json must be a flat object of strings")
    })
}

/// Message for `key`, or the key itself if it is missing (visible, not fatal).
pub fn t(key: &str) -> String {
    catalog().get(key).cloned().unwrap_or_else(|| key.to_string())
}

/// Like `t`, with `{name}` placeholders replaced by `params`.
pub fn t_with(key: &str, params: &[(&str, &str)]) -> String {
    params.iter().fold(t(key), |text, (name, value)| {
        text.replace(&format!("{{{name}}}"), value)
    })
}
