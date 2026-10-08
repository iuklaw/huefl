// The sync settings: Brightness (a range), Speed, Vividness, Sensitivity.
//
// The UI sends slider positions (0..1). What a position means is up to each
// mode, and lives here: Speed is the palette's cycle speed in Ambient, the
// fade-out in Music, the reaction time in Screen. The tables are the four
// Intensity steps of earlier versions; positions k/3 land exactly on step k,
// so the Intensity presets behave as they always did.
//
// Settings can change while streaming (sync_tune): effects and the audio
// analyzer read the shared copy every frame.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::effects::Rgb;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub brightness_min: f32,
    pub brightness_max: f32,
    pub speed: f32,
    pub vividness: f32,
    /// Music only: how easily a beat triggers.
    pub sensitivity: f32,
}

impl Default for Tuning {
    /// Intensity "Medium" with neutral colors and full brightness.
    fn default() -> Self {
        Self { brightness_min: 0.0, brightness_max: 1.0, speed: 1.0 / 3.0, vividness: 0.5, sensitivity: 0.5 }
    }
}

pub type SharedTuning = Arc<Mutex<Tuning>>;

/// Ambient: palette cycles per second.
const CYCLE_SPEED: [f32; 4] = [0.03, 0.07, 0.15, 0.35];
/// Music: fade-out time, seconds.
const RELEASE: [f32; 4] = [0.6, 0.35, 0.2, 0.1];
/// Screen: reaction time, seconds.
const SCREEN_FOLLOW: [f32; 4] = [0.5, 0.25, 0.12, 0.05];

impl Tuning {
    pub fn cycle_speed(&self) -> f32 {
        steps(&CYCLE_SPEED, self.speed)
    }

    pub fn music_release(&self) -> f32 {
        steps(&RELEASE, self.speed)
    }

    pub fn screen_follow(&self) -> f32 {
        steps(&SCREEN_FOLLOW, self.speed)
    }

    /// Ambient and music: saturation applied to the palette's colors. The
    /// middle leaves them as they are.
    pub fn palette_saturation(&self) -> f32 {
        let v = self.vividness.clamp(0.0, 1.0);
        if v < 0.5 { 0.3 + 1.4 * v } else { 1.0 + 1.6 * (v - 0.5) }
    }

    /// Music: beat threshold in standard deviations above the recent bass
    /// flux. Higher sensitivity, lower threshold: 3.0 … 1.5 (middle) … 0.75.
    pub fn beat_sigma(&self) -> f32 {
        1.5 * 2f32.powf(1.0 - 2.0 * self.sensitivity.clamp(0.0, 1.0))
    }
}

/// Piecewise-linear read of a four-step table: position 0 is step 0, 1 is step 3.
pub fn steps(table: &[f32; 4], position: f32) -> f32 {
    let x = position.clamp(0.0, 1.0) * 3.0;
    let i = (x.floor() as usize).min(2);
    let t = x - i as f32;
    table[i] + (table[i + 1] - table[i]) * t
}

/// Brightness as a range: each light's level (its brightest channel) is
/// mapped into min..max, keeping the hue. A light the effect leaves dark
/// glows at min in its last color, so lights don't go black in quiet passages
/// or dark scenes.
///
/// The map's slope (max - min) is at most 1, so it never makes a rise larger
/// than the effect produced - the photosensitivity limiter's guarantee holds.
#[derive(Default)]
pub struct BrightnessStage {
    /// Last seen hue per channel, scaled to a level of 1.
    hues: Vec<Rgb>,
}

/// Below this level a color carries no usable hue.
const DARK: f32 = 1e-6;

impl BrightnessStage {
    pub fn apply(&mut self, tuning: &Tuning, colors: &mut [Rgb]) {
        self.hues.resize(colors.len(), [1.0; 3]);
        let min = tuning.brightness_min.clamp(0.0, 1.0);
        let max = tuning.brightness_max.clamp(min, 1.0);
        for (color, hue) in colors.iter_mut().zip(&mut self.hues) {
            let level = color.iter().cloned().fold(0.0f32, f32::max);
            if level > DARK {
                *hue = color.map(|c| c / level);
            }
            if min == 0.0 && max == 1.0 {
                continue; // full range: as rendered
            }
            let mapped = min + (max - min) * level.min(1.0);
            *color = hue.map(|c| c * mapped);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(speed: f32, vividness: f32) -> Tuning {
        Tuning { speed, vividness, ..Tuning::default() }
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn intensity_steps_are_the_old_tables() {
        for k in 0..4 {
            let t = at(k as f32 / 3.0, 0.5);
            assert!(close(t.cycle_speed(), CYCLE_SPEED[k]), "{k}");
            assert!(close(t.music_release(), RELEASE[k]), "{k}");
            assert!(close(t.screen_follow(), SCREEN_FOLLOW[k]), "{k}");
        }
    }

    #[test]
    fn steps_blend_between_entries_and_clamp() {
        let table = [0.0, 1.0, 2.0, 3.0];
        assert!(close(steps(&table, 0.5), 1.5));
        assert_eq!(steps(&table, -1.0), 0.0);
        assert_eq!(steps(&table, 2.0), 3.0);
    }

    #[test]
    fn middle_vividness_leaves_palettes_alone() {
        assert_eq!(at(0.0, 0.5).palette_saturation(), 1.0);
        assert!(at(0.0, 0.0).palette_saturation() < 1.0);
        assert!(at(0.0, 1.0).palette_saturation() > 1.0);
    }

    #[test]
    fn sensitivity_moves_the_beat_threshold() {
        let sigma = |s| Tuning { sensitivity: s, ..Tuning::default() }.beat_sigma();
        assert!(close(sigma(0.5), 1.5));
        assert!(close(sigma(0.0), 3.0));
        assert!(close(sigma(1.0), 0.75));
    }

    fn range(min: f32, max: f32) -> Tuning {
        Tuning { brightness_min: min, brightness_max: max, ..Tuning::default() }
    }

    #[test]
    fn full_range_changes_nothing() {
        let mut colors = vec![[0.5, 0.25, 0.0], [0.0; 3]];
        BrightnessStage::default().apply(&range(0.0, 1.0), &mut colors);
        assert_eq!(colors, vec![[0.5, 0.25, 0.0], [0.0; 3]]);
    }

    #[test]
    fn range_maps_the_level_and_keeps_the_hue() {
        let mut stage = BrightnessStage::default();
        let mut colors = vec![[1.0, 0.5, 0.0], [0.5, 0.25, 0.0]];
        stage.apply(&range(0.2, 0.6), &mut colors);
        assert!(close(colors[0][0], 0.6) && close(colors[0][1], 0.3), "{colors:?}");
        assert!(close(colors[1][0], 0.4) && close(colors[1][1], 0.2), "{colors:?}");
        assert_eq!(colors[0][2], 0.0);
    }

    #[test]
    fn dark_lights_glow_at_the_minimum_in_their_last_color() {
        let mut stage = BrightnessStage::default();
        let tuning = range(0.1, 1.0);
        stage.apply(&tuning, &mut [[0.0, 0.8, 0.4]]);
        let mut dark = [[0.0; 3]];
        stage.apply(&tuning, &mut dark);
        assert!(close(dark[0][1], 0.1) && close(dark[0][2], 0.05), "{dark:?}");
    }

    #[test]
    fn a_range_never_makes_rises_larger() {
        let mut stage = BrightnessStage::default();
        let tuning = range(0.3, 0.9);
        let mut previous: Option<(f32, f32)> = None;
        for level in [0.0, 1.0, 0.0, 0.5, 1.0, 0.2] {
            let mut colors = [[level, level * 0.5, 0.0]];
            stage.apply(&tuning, &mut colors);
            let out = colors[0][0];
            if let Some((level_before, out_before)) = previous {
                let rise_in = (level - level_before).max(0.0);
                assert!(out - out_before <= rise_in + 1e-6, "{level_before}->{level}: {out_before} -> {out}");
            }
            previous = Some((level, out));
        }
    }
}
