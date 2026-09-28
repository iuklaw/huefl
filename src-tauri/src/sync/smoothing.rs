// Making raw audio features pleasant to look at, and safe.
//
// `Envelope`: fast attack, slower release — lights jump up with a hit and fade
// out, instead of flickering with every sample.
//
// `SafetyLimiter`: photosensitivity guard (WCAG 2.3.1: no more than three
// flashes per second). A "flash" here is a large, quick brightness rise; after
// three within a second, further rises are slowed to a gentle ramp until the
// window clears. Applied to the whole frame, since lights flashing together
// read as one flash.

use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, Default)]
pub struct Envelope {
    value: f32,
}

impl Envelope {
    /// Move toward `target`; `attack` / `release` are time constants in seconds.
    pub fn step(&mut self, target: f32, dt: f32, attack: f32, release: f32) -> f32 {
        let tau = if target > self.value { attack } else { release };
        let k = if tau <= 0.0 { 1.0 } else { 1.0 - (-dt / tau).exp() };
        self.value += (target - self.value) * k;
        self.value
    }
}

/// A rise at least this large within one frame counts as a flash.
const FLASH_RISE: f32 = 0.25;
const MAX_FLASHES_PER_SECOND: usize = 3;
/// Rise speed allowed once the budget is used up (full range in ~1.4 s).
const GENTLE_RISE_PER_SECOND: f32 = 0.7;

#[derive(Default)]
pub struct SafetyLimiter {
    clock: f32,
    flashes: VecDeque<f32>,
    last: Vec<f32>,
    /// Flashes held back — reported in the sync stats.
    pub limited: u32,
}

impl SafetyLimiter {
    /// Limit `levels` (0..1 brightness per channel) in place.
    pub fn apply(&mut self, dt: f32, levels: &mut [f32]) {
        self.clock += dt;
        while self.flashes.front().is_some_and(|&t| self.clock - t > 1.0) {
            self.flashes.pop_front();
        }
        if self.last.len() != levels.len() {
            self.last = levels.to_vec();
            return;
        }

        let flashing = levels.iter().zip(&self.last).any(|(now, before)| now - before >= FLASH_RISE);
        if flashing {
            if self.flashes.len() < MAX_FLASHES_PER_SECOND {
                self.flashes.push_back(self.clock);
            } else {
                self.limited += 1;
                let max_rise = GENTLE_RISE_PER_SECOND * dt;
                for (level, before) in levels.iter_mut().zip(&self.last) {
                    *level = level.min(before + max_rise);
                }
            }
        }
        self.last.copy_from_slice(levels);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_attacks_fast_and_releases_slow() {
        let mut env = Envelope::default();
        let up = env.step(1.0, 0.02, 0.01, 0.5);
        assert!(up > 0.8, "{up}");
        let down = env.step(0.0, 0.02, 0.01, 0.5);
        assert!(down > 0.75, "{down}");
    }

    #[test]
    fn limiter_allows_three_flashes_per_second() {
        let mut limiter = SafetyLimiter::default();
        let dt = 0.02;
        // A 10 Hz strobe (dark / full every 50 ms) for 2 s.
        let mut rises = 0;
        let mut previous = 0.0;
        for frame in 0..100 {
            let target = if (frame / 3) % 2 == 0 { 0.0 } else { 1.0 };
            let mut levels = [target];
            limiter.apply(dt, &mut levels);
            if levels[0] - previous >= FLASH_RISE {
                rises += 1;
            }
            previous = levels[0];
        }
        assert!(rises <= 2 * MAX_FLASHES_PER_SECOND + 1, "rises: {rises}");
        assert!(limiter.limited > 0);
    }

    #[test]
    fn limiter_leaves_calm_changes_alone() {
        let mut limiter = SafetyLimiter::default();
        for i in 0..100 {
            let mut levels = [i as f32 / 100.0];
            limiter.apply(0.02, &mut levels);
            assert_eq!(levels[0], i as f32 / 100.0);
        }
        assert_eq!(limiter.limited, 0);
    }
}
