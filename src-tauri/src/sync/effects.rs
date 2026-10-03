// What the lights show while syncing. Each effect turns elapsed time and its
// input (nothing, audio features, later the screen) into one color per channel.
//
// The stream thread calls `render` 50 times a second. Effects hold no devices
// themselves - MusicEffect only reads shared `Features` - so all are testable.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::audio::analyzer::{Features, SPECTRUM_BANDS};
use super::entertainment::api::AreaChannel;
use super::screen::zones::{zone_colors, Grid, ZoneStyle};
use super::smoothing::{Envelope, SafetyLimiter};

/// Linear RGB, 0.0..=1.0.
pub type Rgb = [f32; 3];

pub trait Effect: Send {
    /// `dt`: seconds since the previous frame. One color per channel, same order.
    fn render(&mut self, dt: f32, channels: &[AreaChannel]) -> Vec<Rgb>;

    /// Music: the bars of the UI's spectrum visualizer (0..1).
    fn spectrum(&self) -> Option<[f32; SPECTRUM_BANDS]> {
        None
    }

    /// Screen: the coarse screen grid for the UI's preview, sRGB bytes
    /// (R, G, B per cell, row-major, zones::GRID_COLS × GRID_ROWS), and the
    /// picture's width / height.
    fn screen_preview(&self) -> Option<(Vec<u8>, f32)> {
        None
    }

    /// Flashes held back by the photosensitivity limiter, for the stats.
    fn limited_flashes(&self) -> u32 {
        0
    }

    /// The input (audio) is gone for now - the UI says it is waiting.
    fn input_lost(&self) -> bool {
        false
    }

    /// The input can't work at all: the session ends with this message.
    fn failure(&self) -> Option<String> {
        None
    }
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

// --- Music -----------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MusicStyle {
    /// All lights breathe with the loudness; the color moves on with each beat.
    Pulse,
    /// Lights split the spectrum left to right: bass, mid, treble.
    Spectrum,
}

impl MusicStyle {
    pub fn parse(value: Option<&str>) -> Self {
        // Anything unknown - including the retired "beat" - plays as Pulse.
        match value {
            Some("spectrum") => Self::Spectrum,
            _ => Self::Pulse,
        }
    }
}

/// Fade-out time per intensity step (0 subtle … 3 extreme), seconds.
const RELEASE: [f32; 4] = [0.6, 0.35, 0.2, 0.1];
const ATTACK: f32 = 0.03;
/// Lights never go fully dark in quiet passages.
const FLOOR: f32 = 0.05;

pub struct MusicEffect {
    style: MusicStyle,
    palette: Vec<Rgb>,
    release: f32,
    features: Arc<Mutex<Features>>,
    latest: Features,
    last_beats: u64,
    envelopes: Vec<Envelope>,
    /// Palette position: `target` jumps on beats, `current` glides after it.
    color_target: f32,
    color_current: f32,
    safe: Option<SafetyLimiter>,
    lost: Arc<AtomicBool>,
}

impl MusicEffect {
    pub fn new(
        style: MusicStyle,
        palette: Vec<Rgb>,
        intensity: u8,
        safe_mode: bool,
        features: Arc<Mutex<Features>>,
        lost: Arc<AtomicBool>,
    ) -> Self {
        let palette = if palette.is_empty() { vec![[1.0, 1.0, 1.0]] } else { palette };
        Self {
            style,
            palette,
            release: RELEASE[usize::from(intensity.min(3))],
            features,
            latest: Features::default(),
            last_beats: 0,
            envelopes: Vec::new(),
            color_target: 0.0,
            color_current: 0.0,
            safe: safe_mode.then(SafetyLimiter::default),
            lost,
        }
    }
}

impl Effect for MusicEffect {
    fn render(&mut self, dt: f32, channels: &[AreaChannel]) -> Vec<Rgb> {
        self.latest = *self.features.lock().unwrap();
        let f = self.latest;
        let beat = f.beats != self.last_beats;
        self.last_beats = f.beats;

        let n = channels.len();
        self.envelopes.resize(n, Envelope::default());
        let ranks = left_to_right(channels);
        let palette_len = self.palette.len() as f32;

        if beat {
            self.color_target += 1.0;
        }
        // Colors glide to the next palette entry; slower in safe mode.
        let glide = if self.safe.is_some() { 0.25 } else { 0.08 };
        self.color_current += (self.color_target - self.color_current) * (1.0 - (-dt / glide).exp());

        let mut levels: Vec<f32> = (0..n)
            .map(|i| {
                let target = match self.style {
                    MusicStyle::Pulse => f.energy,
                    MusicStyle::Spectrum => f.bands[band_of(ranks[i], n)],
                };
                let level = self.envelopes[i].step(target, dt, ATTACK, self.release);
                FLOOR + (1.0 - FLOOR) * level.clamp(0.0, 1.0)
            })
            .collect();
        if let Some(limiter) = &mut self.safe {
            limiter.apply(dt, &mut levels);
        }

        (0..n)
            .map(|i| {
                let rank = ranks[i] as f32;
                let position = match self.style {
                    // Neighbours a step apart in the palette, all moving on beats.
                    MusicStyle::Pulse => self.color_current + rank * 0.5,
                    // One color per band, fixed, so each band keeps its identity.
                    MusicStyle::Spectrum => band_of(ranks[i], n) as f32,
                };
                let color = sample_cyclic(&self.palette, position / palette_len);
                color.map(|c| c * levels[i])
            })
            .collect()
    }

    fn spectrum(&self) -> Option<[f32; SPECTRUM_BANDS]> {
        Some(self.latest.spectrum)
    }

    fn limited_flashes(&self) -> u32 {
        self.safe.as_ref().map_or(0, |s| s.limited)
    }

    fn input_lost(&self) -> bool {
        self.lost.load(Ordering::Relaxed)
    }
}

// --- Screen ------------------------------------------------------------------

/// Reaction time per intensity step (0 subtle … 3 extreme), seconds. How
/// vivid the colors are also follows intensity: zones::ZoneStyle.
const SCREEN_FOLLOW: [f32; 4] = [0.5, 0.25, 0.12, 0.05];
/// Seconds without a picture before the UI says it's waiting for the screen.
const NO_PICTURE_AFTER: f32 = 5.0;

/// Each light follows the part of the screen matching its place in the area
/// (screen::zones). Colors glide rather than jump; the safe mode caps flashes
/// here too - films and games have explosions and strobes.
pub struct ScreenEffect {
    grid: Arc<Mutex<Option<Grid>>>,
    follow: f32,
    style: ZoneStyle,
    envelopes: Vec<[Envelope; 3]>,
    safe: Option<SafetyLimiter>,
    lost: Arc<AtomicBool>,
    /// Set by capture when it can never give a picture.
    failure: Arc<Mutex<Option<String>>>,
    /// Seconds rendered without a picture (none yet, or capture stalled).
    no_picture: f32,
}

impl ScreenEffect {
    pub fn new(
        intensity: u8,
        safe_mode: bool,
        grid: Arc<Mutex<Option<Grid>>>,
        lost: Arc<AtomicBool>,
        failure: Arc<Mutex<Option<String>>>,
    ) -> Self {
        Self {
            grid,
            follow: SCREEN_FOLLOW[usize::from(intensity.min(3))],
            style: ZoneStyle::for_intensity(intensity),
            envelopes: Vec::new(),
            safe: safe_mode.then(SafetyLimiter::default),
            lost,
            failure,
            no_picture: 0.0,
        }
    }
}

impl Effect for ScreenEffect {
    fn render(&mut self, dt: f32, channels: &[AreaChannel]) -> Vec<Rgb> {
        let targets = match self.grid.lock().unwrap().as_ref() {
            Some(grid) => {
                self.no_picture = 0.0;
                zone_colors(grid, channels, self.style)
            }
            None => {
                self.no_picture += dt;
                vec![[0.0; 3]; channels.len()]
            }
        };
        self.envelopes.resize(channels.len(), [Envelope::default(); 3]);
        let mut colors: Vec<Rgb> = targets
            .iter()
            .zip(&mut self.envelopes)
            .map(|(target, env)| [0, 1, 2].map(|c| env[c].step(target[c], dt, self.follow, self.follow)))
            .collect();

        if let Some(limiter) = &mut self.safe {
            let before: Vec<f32> = colors.iter().map(|c| c.iter().cloned().fold(0.0, f32::max)).collect();
            let mut after = before.clone();
            limiter.apply(dt, &mut after);
            for ((color, b), a) in colors.iter_mut().zip(&before).zip(&after) {
                if *b > 0.0 && a < b {
                    *color = color.map(|v| v * a / b);
                }
            }
        }
        colors
    }

    fn screen_preview(&self) -> Option<(Vec<u8>, f32)> {
        let grid = self.grid.lock().unwrap();
        let grid = grid.as_ref()?;
        Some((grid.cells.iter().flat_map(|c| c.map(linear_to_srgb8)).collect(), grid.aspect))
    }

    fn limited_flashes(&self) -> u32 {
        self.safe.as_ref().map_or(0, |s| s.limited)
    }

    fn input_lost(&self) -> bool {
        // A picture that never came (or stopped coming) is as good as lost:
        // without this the lights just stay dark with nothing said.
        self.lost.load(Ordering::Relaxed) || self.no_picture >= NO_PICTURE_AFTER
    }

    fn failure(&self) -> Option<String> {
        self.failure.lock().unwrap().clone()
    }
}

/// Which band a light shows in the spectrum style: the leftmost third bass,
/// then mid, then treble (one light: bass; two: bass and treble).
fn band_of(rank: usize, n: usize) -> usize {
    match n {
        0 | 1 => 0,
        2 => rank * 2,
        _ => (rank * 3 / n).min(2),
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

/// "#RRGGBB" to linear-light RGB (sRGB gamma removed - lights mix in linear).
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

/// Linear 0..1 -> an sRGB byte, for what the UI shows.
pub fn linear_to_srgb8(v: f32) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0).round() as u8
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

    fn music(style: MusicStyle, safe: bool) -> (MusicEffect, Arc<Mutex<Features>>) {
        let features = Arc::new(Mutex::new(Features::default()));
        let palette = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        (MusicEffect::new(style, palette, 1, safe, features.clone(), Arc::default()), features)
    }

    fn brightness(rgb: Rgb) -> f32 {
        rgb.iter().cloned().fold(0.0, f32::max)
    }

    #[test]
    fn spectrum_maps_bands_left_to_right() {
        let (mut effect, features) = music(MusicStyle::Spectrum, false);
        *features.lock().unwrap() = Features { energy: 1.0, bands: [1.0, 0.0, 0.0], beats: 0, ..Features::default() };
        let channels = [channel(0, 0.9), channel(1, -0.9), channel(2, 0.0)];
        let mut colors = vec![];
        for _ in 0..25 {
            colors = effect.render(0.02, &channels);
        }
        // Channel 1 is leftmost -> bass -> bright; channel 0 rightmost -> treble -> floor.
        assert!(brightness(colors[1]) > 0.9, "{colors:?}");
        assert!(brightness(colors[0]) < 0.1, "{colors:?}");
    }

    #[test]
    fn pulse_follows_energy_and_fades() {
        let (mut effect, features) = music(MusicStyle::Pulse, false);
        let channels = [channel(0, 0.0)];
        *features.lock().unwrap() = Features { energy: 1.0, bands: [0.0; 3], beats: 0, ..Features::default() };
        for _ in 0..10 {
            effect.render(0.02, &channels);
        }
        let loud = brightness(effect.render(0.02, &channels)[0]);
        *features.lock().unwrap() = Features::default();
        let after = brightness(effect.render(0.02, &channels)[0]);
        assert!(loud > 0.95 && after < loud && after > 0.8, "{loud} -> {after}");
    }

    #[test]
    fn beats_move_the_color_on() {
        let (mut effect, features) = music(MusicStyle::Pulse, false);
        let channels = [channel(0, 0.0)];
        *features.lock().unwrap() = Features { energy: 1.0, bands: [0.0; 3], beats: 0, ..Features::default() };
        let mut before = [0.0; 3];
        for _ in 0..30 {
            before = effect.render(0.02, &channels)[0];
        }
        features.lock().unwrap().beats = 1;
        let mut after = before;
        for _ in 0..30 {
            after = effect.render(0.02, &channels)[0];
        }
        assert!(before[0] > 0.9 && after[1] > 0.9, "red -> green: {before:?} -> {after:?}");
    }

    #[test]
    fn safe_mode_limits_pulse_flashes() {
        // Extreme intensity (fastest fade) and loudness jumping silent ↔ full
        // five times a second for 2 s: without the limiter, a strobe. The
        // output must not flash more than 3 times a second.
        let features = Arc::new(Mutex::new(Features::default()));
        let mut effect = MusicEffect::new(MusicStyle::Pulse, vec![[1.0, 1.0, 1.0]], 3, true, features.clone(), Arc::default());
        let channels = [channel(0, 0.0)];
        let mut previous = 0.0;
        let mut big_rises = 0;
        for frame in 0..100u32 {
            let loud = (frame / 5) % 2 == 1;
            features.lock().unwrap().energy = if loud { 1.0 } else { 0.0 };
            let level = brightness(effect.render(0.02, &channels)[0]);
            if level - previous >= 0.25 {
                big_rises += 1;
            }
            previous = level;
        }
        assert!(big_rises <= 2 * 3 + 1, "big rises in 2 s: {big_rises}");
        assert!(effect.limited_flashes() > 0, "the limiter had to step in");
    }

    #[test]
    fn screen_effect_follows_the_grid_and_dims_without_it() {
        use crate::sync::screen::zones::{GRID_COLS, GRID_ROWS};
        let red = Grid { cells: vec![[1.0, 0.0, 0.0]; GRID_COLS * GRID_ROWS], aspect: 16.0 / 9.0 };
        let grid = Arc::new(Mutex::new(Some(red)));
        let mut effect = ScreenEffect::new(3, false, grid.clone(), Arc::default(), Arc::default());
        let channels = [channel(0, 0.0)];
        let mut color = [0.0; 3];
        for _ in 0..25 {
            color = effect.render(0.02, &channels)[0];
        }
        assert!(color[0] > 0.9 && color[1] < 0.05, "{color:?}");
        *grid.lock().unwrap() = None; // capture lost
        for _ in 0..25 {
            color = effect.render(0.02, &channels)[0];
        }
        assert!(color[0] < 0.05, "dims when the screen is gone: {color:?}");
    }

    #[test]
    fn screen_effect_says_when_no_picture_comes() {
        let grid = Arc::new(Mutex::new(None));
        let mut effect = ScreenEffect::new(1, false, grid.clone(), Arc::default(), Arc::default());
        let channels = [channel(0, 0.0)];
        for _ in 0..200 {
            effect.render(0.02, &channels); // 4 s: still starting up
        }
        assert!(!effect.input_lost());
        for _ in 0..100 {
            effect.render(0.02, &channels);
        }
        assert!(effect.input_lost(), "no picture for 6 s");

        use crate::sync::screen::zones::{GRID_COLS, GRID_ROWS};
        *grid.lock().unwrap() = Some(Grid { cells: vec![[0.5; 3]; GRID_COLS * GRID_ROWS], aspect: 1.0 });
        effect.render(0.02, &channels);
        assert!(!effect.input_lost(), "the picture is back");
    }

    #[test]
    fn screen_effect_reports_a_capture_failure() {
        let failure = Arc::new(Mutex::new(None));
        let effect = ScreenEffect::new(1, false, Arc::default(), Arc::default(), failure.clone());
        assert_eq!(effect.failure(), None);
        *failure.lock().unwrap() = Some("unreadable frames".to_string());
        assert_eq!(effect.failure().as_deref(), Some("unreadable frames"));
    }

    #[test]
    fn retired_beat_style_plays_as_pulse() {
        assert_eq!(MusicStyle::parse(Some("beat")), MusicStyle::Pulse);
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
