// "Color of the day" from colors.zoodinkers.com — one color a day, which the
// UI spreads into a palette for a room's lights (lib/color.ts).
//
// Fetched here because the webview's CSP keeps it off the internet. One
// request a day: the answer is kept in the state dir, so the color also works
// offline for the rest of that day. Without it and without a network, the UI
// greys the option out.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const API: &str = "https://colors.zoodinkers.com/api";
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DailyColor {
    /// YYYY-MM-DD
    pub date: String,
    /// "#rrggbb"
    pub hex: String,
}

fn cache_path() -> PathBuf {
    crate::paths::state_dir().join("color-of-the-day.json")
}

/// The color for `date` (the user's local day, YYYY-MM-DD): from the cache if
/// it's that day's, else from the service.
#[tauri::command]
pub async fn color_of_the_day(date: String) -> Result<DailyColor, String> {
    if !is_date(&date) {
        return Err(format!("not a date: {date}"));
    }
    if let Some(cached) = read_cache().filter(|c| c.date == date) {
        return Ok(cached);
    }
    let response = reqwest::Client::new()
        .get(API)
        .query(&[("date", &date)])
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("color of the day: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("color of the day: HTTP {}", response.status().as_u16()));
    }
    let text = response.text().await.map_err(|e| format!("color of the day: {e}"))?;
    let color = parse(&text)?;
    write_cache(&color);
    Ok(color)
}

/// `{"date":"2026-10-01","hex":"#545575"}` → a checked, lower-case color.
fn parse(text: &str) -> Result<DailyColor, String> {
    let color: DailyColor = serde_json::from_str(text).map_err(|e| format!("color of the day: {e}"))?;
    let hex = color.hex.to_ascii_lowercase();
    let valid = hex.len() == 7 && hex.starts_with('#') && hex[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid || !is_date(&color.date) {
        return Err(format!("color of the day: unexpected answer {text}"));
    }
    Ok(DailyColor { date: color.date, hex })
}

fn is_date(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn read_cache() -> Option<DailyColor> {
    parse(&std::fs::read_to_string(cache_path()).ok()?).ok()
}

fn write_cache(color: &DailyColor) {
    let path = cache_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(color) {
        let _ = std::fs::write(path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_service_answer() {
        assert_eq!(
            parse(r##"{"date":"2026-10-01","hex":"#54557A"}"##),
            Ok(DailyColor { date: "2026-10-01".into(), hex: "#54557a".into() })
        );
    }

    #[test]
    fn rejects_odd_answers() {
        for text in [
            r##"{"date":"2026-10-01","hex":"545575"}"##,
            r##"{"date":"2026-10-01","hex":"#54557g"}"##,
            r##"{"date":"yesterday","hex":"#545575"}"##,
            r##"<html>maintenance</html>"##,
        ] {
            assert!(parse(text).is_err(), "{text}");
        }
    }

    #[test]
    fn dates_are_checked() {
        assert!(is_date("2026-10-01"));
        assert!(!is_date("2026-1-01"));
        assert!(!is_date("2026/10/01"));
    }

    /// Live: today's color. `cargo test --lib live_color_of_the_day -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_color_of_the_day() {
        let response = reqwest::get(API).await.unwrap().text().await.unwrap();
        println!("{:?}", parse(&response));
    }
}
