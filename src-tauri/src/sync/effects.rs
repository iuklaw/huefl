// What the lights show while syncing. Each effect turns elapsed time (and, in
// later stages, audio or screen features) into one color per channel.
//
// Pure and I/O-free; the stream thread calls `render` 50 times a second.

use super::entertainment::api::AreaChannel;

/// Linear RGB, 0.0..=1.0.
pub type Rgb = [f32; 3];

pub trait Effect: Send {
    /// `dt`: seconds since the previous frame. One color per channel, same order.
    fn render(&mut self, dt: f32, channels: &[AreaChannel]) -> Vec<Rgb>;
}

/// Speed per intensity step (0 subtle … 3 extreme), in palette cycles per second.
const CYCLE_SPEED: [f32; 4] = [0.03, 0.07, 0.15, 0.35];

/// "Test": the palette flows slowly across the lights, left to right. Proves
/// the whole pipeline end to end before music and screen exist.
pub struct PaletteCycle {
    palette: Vec<Rgb>,
    speed: f32,
    phase: f32,
}

impl PaletteCycle {
    pub fn new(palette: Vec<Rgb>, intensity: u8) -> Self {
        let palette = if palette.is_empty() { vec![[1.0, 1.0, 1.0]] } else { palette };
        Self { palette, speed: CYCLE_SPEED[usize::from(intensity.min(3))], phase: 0.0 }
    }
}

impl Effect for PaletteCycle {
    fn render(&mut self, dt: f32, channels: &[AreaChannel]) -> Vec<Rgb> {
        self.phase = (self.phase + dt * self.speed).fract();
        let order = left_to_right(channels);
        let n = channels.len().max(1) as f32;
        order
            .iter()
            .map(|&rank| sample_cyclic(&self.palette, self.phase + rank as f32 / n))
            .collect()
    }
}

/// Each channel's rank by x position (0 = leftmost), in channel order.
pub fn left_to_right(channels: &[AreaChannel]) -> Vec<usize> {
    let mut sorted: Vec<usize> = (0..channels.len()).collect();
    sorted.sort_by(|&a, &b| channels[a].position.x.total_cmp(&channels[b].position.x));
    let mut rank = vec![0; channels.len()];
    for (r, &i) in sorted.iter().enumerate() {
        rank[i] = r;
    }
    rank
}

/// Palette as a closed loop; `t` wraps, colors blend linearly between entries.
pub fn sample_cyclic(palette: &[Rgb], t: f32) -> Rgb {
    let n = palette.len();
    if n == 1 {
        return palette[0];
    }
    let pos = t.rem_euclid(1.0) * n as f32;
    let i = pos.floor() as usize % n;
    let f = pos.fract();
    let (a, b) = (palette[i], palette[(i + 1) % n]);
    [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/// "#RRGGBB" to linear-light RGB (sRGB gamma removed — lights mix in linear).
pub fn parse_hex(hex: &str) -> Option<Rgb> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let channel = |i: usize| -> Option<f32> {
        let v = u8::from_str_radix(&hex[i..i + 2], 16).ok()? as f32 / 255.0;
        Some(if v > 0.04045 { ((v + 0.055) / 1.055).powf(2.4) } else { v / 12.92 })
    };
    Some([channel(0)?, channel(2)?, channel(4)?])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::entertainment::api::Position;

    fn channel(id: u8, x: f64) -> AreaChannel {
        AreaChannel { channel_id: id, position: Position { x, y: 0.0, z: 0.0 } }
    }

    #[test]
    fn ranks_channels_left_to_right() {
        let channels = [channel(0, 0.46), channel(1, -0.53), channel(2, 0.0)];
        assert_eq!(left_to_right(&channels), vec![2, 0, 1]);
    }

    #[test]
    fn cyclic_sampling_blends_and_wraps() {
        let palette = [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
        assert_eq!(sample_cyclic(&palette, 0.0), [1.0, 0.0, 0.0]);
        assert_eq!(sample_cyclic(&palette, 0.25), [0.5, 0.0, 0.5]);
        assert_eq!(sample_cyclic(&palette, 0.5), [0.0, 0.0, 1.0]);
        assert_eq!(sample_cyclic(&palette, 1.0), sample_cyclic(&palette, 0.0));
        assert_eq!(sample_cyclic(&palette, -0.5), sample_cyclic(&palette, 0.5));
    }

    #[test]
    fn palette_cycle_renders_one_color_per_channel() {
        let mut effect = PaletteCycle::new(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], 1);
        let channels = [channel(0, -1.0), channel(1, 0.0), channel(2, 1.0)];
        let colors = effect.render(0.0, &channels);
        assert_eq!(colors, vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
        let later = effect.render(1.0, &channels);
        assert_ne!(later, colors, "the palette moves over time");
    }

    #[test]
    fn hex_is_linearized() {
        assert_eq!(parse_hex("#FFFFFF"), Some([1.0, 1.0, 1.0]));
        assert_eq!(parse_hex("#000000"), Some([0.0, 0.0, 0.0]));
        let mid = parse_hex("#808080").unwrap()[0];
        assert!((mid - 0.2158).abs() < 0.001, "{mid}");
        assert_eq!(parse_hex("nope"), None);
    }
}
