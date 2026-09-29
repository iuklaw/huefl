// Turns raw audio into what the lights react to: loudness, three frequency
// bands, and beats. Pure — fed with sample blocks, no devices — so it is
// tested with synthetic signals.
//
//   FFT (1024 samples, Hann window, 48 kHz → ~47 Hz per bin)
//   → band amplitudes: bass 20–250 Hz, mid 250–4000 Hz, treble 4–16 kHz
//   → automatic gain: each value relative to its own recent peak, so quiet and
//     loud music both use the full range
//   → beat: bass spectral flux above an adaptive threshold (mean + 1.5σ of the
//     last second), at most one every 250 ms (240 BPM)
//   → spectrum: 24 log-spaced bars for the UI's visualizer, from the same FFT

use std::collections::VecDeque;
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

pub const SAMPLE_RATE: f32 = 48_000.0;
pub const FFT_SIZE: usize = 1024;
/// Hop between analyses; capture delivers blocks of this size (~10.7 ms).
pub const BLOCK: usize = 512;

const BANDS_HZ: [(f32, f32); 3] = [(20.0, 250.0), (250.0, 4_000.0), (4_000.0, 16_000.0)];
/// Peak memory for automatic gain: decays to half in ~7 s at 94 blocks/s.
const PEAK_DECAY: f32 = 0.999;
const PEAK_FLOOR: f32 = 1e-3;
/// Below this RMS the input counts as silence (no gain boost of noise).
const SILENCE_RMS: f32 = 1e-4;
const FLUX_HISTORY: usize = 94; // ~1 s
const BEAT_SIGMA: f32 = 1.5;
const MIN_BEAT_INTERVAL: f32 = 0.25;

/// Bars of the UI's spectrum: log-spaced from 60 Hz to 16 kHz.
pub const SPECTRUM_BANDS: usize = 24;
const SPECTRUM_HZ: (f32, f32) = (60.0, 16_000.0);
/// Loudness shown per bar: this many dB below the recent peak reads as zero.
const SPECTRUM_RANGE_DB: f32 = 50.0;
/// How far a bar may fall per block (~0.5 s from full to empty); rises are instant.
const SPECTRUM_FALL: f32 = 0.02;

/// Frequency range of spectrum bar `index`.
pub fn spectrum_band(index: usize) -> (f32, f32) {
    let (lo, hi) = SPECTRUM_HZ;
    let edge = |i: usize| lo * (hi / lo).powf(i as f32 / SPECTRUM_BANDS as f32);
    (edge(index), edge(index + 1))
}

/// What the effects read. `beats` counts up — a reader that polls less often
/// than the analyzer runs still sees every beat.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Features {
    /// Overall loudness, 0..1 (gain-normalized).
    pub energy: f32,
    /// Bass, mid, treble, 0..1 each (gain-normalized per band).
    pub bands: [f32; 3],
    pub beats: u64,
    /// For the UI's bars, 0..1 each: dB below a shared peak, so the shape of
    /// the spectrum stays while quiet and loud music both fill the height.
    pub spectrum: [f32; SPECTRUM_BANDS],
}

pub struct Analyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    samples: VecDeque<f32>,
    energy_peak: f32,
    band_peaks: [f32; 3],
    spectrum_peak: f32,
    prev_bass: f32,
    flux: VecDeque<f32>,
    since_beat: f32,
    features: Features,
}

impl Default for Analyzer {
    fn default() -> Self {
        let window = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos())
            .collect();
        Self {
            fft: FftPlanner::new().plan_fft_forward(FFT_SIZE),
            window,
            samples: VecDeque::with_capacity(FFT_SIZE),
            energy_peak: PEAK_FLOOR,
            band_peaks: [PEAK_FLOOR; 3],
            spectrum_peak: PEAK_FLOOR,
            prev_bass: 0.0,
            flux: VecDeque::with_capacity(FLUX_HISTORY),
            since_beat: MIN_BEAT_INTERVAL,
            features: Features::default(),
        }
    }
}

impl Analyzer {
    /// Feed the next block of mono samples; returns the updated features.
    pub fn process(&mut self, block: &[f32]) -> Features {
        for &s in block {
            if self.samples.len() == FFT_SIZE {
                self.samples.pop_front();
            }
            self.samples.push_back(s);
        }
        self.since_beat += block.len() as f32 / SAMPLE_RATE;
        if self.samples.len() < FFT_SIZE {
            return self.features;
        }

        let rms = (block.iter().map(|s| s * s).sum::<f32>() / block.len().max(1) as f32).sqrt();
        if rms < SILENCE_RMS {
            self.energy_peak = (self.energy_peak * PEAK_DECAY).max(PEAK_FLOOR);
            self.features.energy = 0.0;
            self.features.bands = [0.0; 3];
            self.features.spectrum = [0.0; SPECTRUM_BANDS];
            self.prev_bass = 0.0;
            return self.features;
        }

        let magnitudes = self.magnitudes();
        let bands = band_amplitudes(&magnitudes);
        self.update_spectrum(&magnitudes);

        self.energy_peak = (self.energy_peak * PEAK_DECAY).max(rms).max(PEAK_FLOOR);
        self.features.energy = (rms / self.energy_peak).min(1.0);
        for (i, &amp) in bands.iter().enumerate() {
            self.band_peaks[i] = (self.band_peaks[i] * PEAK_DECAY).max(amp).max(PEAK_FLOOR);
            self.features.bands[i] = (amp / self.band_peaks[i]).min(1.0);
        }

        // Beat: a sudden rise in bass, compared with how the bass has moved lately.
        let flux = (bands[0] - self.prev_bass).max(0.0);
        self.prev_bass = bands[0];
        let (mean, std) = mean_std(&self.flux);
        if flux > mean + BEAT_SIGMA * std && flux > 0.05 * self.band_peaks[0] && self.since_beat >= MIN_BEAT_INTERVAL {
            self.features.beats += 1;
            self.since_beat = 0.0;
        }
        if self.flux.len() == FLUX_HISTORY {
            self.flux.pop_front();
        }
        self.flux.push_back(flux);

        self.features
    }

    /// Amplitude per FFT bin (0 … Nyquist) of the current window.
    fn magnitudes(&self) -> Vec<f32> {
        let mut buffer: Vec<Complex<f32>> = self
            .samples
            .iter()
            .zip(&self.window)
            .map(|(s, w)| Complex::new(s * w, 0.0))
            .collect();
        self.fft.process(&mut buffer);
        buffer.iter().take(FFT_SIZE / 2).map(|c| c.norm() / FFT_SIZE as f32).collect()
    }

    fn update_spectrum(&mut self, magnitudes: &[f32]) {
        let bars: [f32; SPECTRUM_BANDS] = std::array::from_fn(|i| {
            let (lo, hi) = spectrum_band(i);
            let (first, last) = ((lo / BIN_HZ).ceil() as usize, (hi / BIN_HZ).ceil() as usize);
            if first < last {
                magnitudes[first.min(magnitudes.len())..last.min(magnitudes.len())].iter().fold(0.0f32, |m, &v| m.max(v))
            } else {
                // Narrower than a bin (the lowest bars): read between the two
                // neighbouring bins, so these bars don't just copy each other.
                let at = (lo * hi).sqrt() / BIN_HZ;
                let k = at.floor() as usize;
                let t = at - k as f32;
                magnitudes[k] * (1.0 - t) + magnitudes[(k + 1).min(magnitudes.len() - 1)] * t
            }
        });

        let loudest = bars.iter().fold(0.0f32, |m, &v| m.max(v));
        self.spectrum_peak = (self.spectrum_peak * PEAK_DECAY).max(loudest).max(PEAK_FLOOR);
        for (shown, &bar) in self.features.spectrum.iter_mut().zip(&bars) {
            let db = 20.0 * (bar.max(1e-9) / self.spectrum_peak).log10();
            let level = (1.0 + db / SPECTRUM_RANGE_DB).clamp(0.0, 1.0);
            *shown = level.max(*shown - SPECTRUM_FALL);
        }
    }
}

const BIN_HZ: f32 = SAMPLE_RATE / FFT_SIZE as f32;

fn band_amplitudes(magnitudes: &[f32]) -> [f32; 3] {
    let mut power = [0.0f32; 3];
    for (k, m) in magnitudes.iter().enumerate().skip(1) {
        let hz = k as f32 * BIN_HZ;
        if let Some(band) = BANDS_HZ.iter().position(|&(lo, hi)| hz >= lo && hz < hi) {
            power[band] += m * m;
        }
    }
    power.map(f32::sqrt)
}

fn mean_std(values: &VecDeque<f32>) -> (f32, f32) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let n = values.len() as f32;
    let mean = values.iter().sum::<f32>() / n;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n;
    (mean, var.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, amplitude: f32, seconds: f32) -> Vec<f32> {
        (0..(SAMPLE_RATE * seconds) as usize)
            .map(|i| amplitude * (2.0 * std::f32::consts::PI * hz * i as f32 / SAMPLE_RATE).sin())
            .collect()
    }

    fn run(analyzer: &mut Analyzer, signal: &[f32]) -> Features {
        let mut last = Features::default();
        for block in signal.chunks(BLOCK) {
            last = analyzer.process(block);
        }
        last
    }

    fn loudest_band(f: &Features) -> usize {
        (0..3).max_by(|&a, &b| f.bands[a].total_cmp(&f.bands[b])).unwrap()
    }

    #[test]
    fn tones_land_in_the_right_band() {
        for (hz, band) in [(60.0, 0), (1_000.0, 1), (8_000.0, 2)] {
            let mut analyzer = Analyzer::default();
            let features = run(&mut analyzer, &sine(hz, 0.5, 1.0));
            assert_eq!(loudest_band(&features), band, "{hz} Hz → {features:?}");
            assert!(features.energy > 0.5, "{features:?}");
        }
    }

    #[test]
    fn automatic_gain_evens_out_loudness() {
        let quiet = run(&mut Analyzer::default(), &sine(1_000.0, 0.02, 1.0));
        let loud = run(&mut Analyzer::default(), &sine(1_000.0, 0.8, 1.0));
        assert!((quiet.energy - loud.energy).abs() < 0.05, "{quiet:?} vs {loud:?}");
    }

    #[test]
    fn silence_is_dark_and_beatless() {
        let features = run(&mut Analyzer::default(), &vec![0.0; 48_000]);
        assert_eq!(features, Features::default());
    }

    #[test]
    fn kicks_at_120_bpm_are_counted() {
        // 4 s of a 60 Hz "kick" (80 ms bursts) every 0.5 s over a soft hi-hat bed.
        let mut signal = vec![0.0f32; (SAMPLE_RATE * 4.0) as usize];
        for (i, s) in signal.iter_mut().enumerate() {
            let t = i as f32 / SAMPLE_RATE;
            *s += 0.02 * (2.0 * std::f32::consts::PI * 9_000.0 * t).sin();
            if t % 0.5 < 0.08 {
                *s += 0.8 * (2.0 * std::f32::consts::PI * 60.0 * t).sin();
            }
        }
        let features = run(&mut Analyzer::default(), &signal);
        assert!((6..=9).contains(&features.beats), "beats: {}", features.beats);
    }

    fn loudest_bar(f: &Features) -> usize {
        (0..SPECTRUM_BANDS).max_by(|&a, &b| f.spectrum[a].total_cmp(&f.spectrum[b])).unwrap()
    }

    #[test]
    fn spectrum_peaks_where_the_tone_is() {
        for hz in [100.0, 1_000.0, 8_000.0] {
            let features = run(&mut Analyzer::default(), &sine(hz, 0.5, 1.0));
            let bar = loudest_bar(&features);
            let (lo, hi) = spectrum_band(bar);
            assert!(lo <= hz * 1.1 && hz <= hi * 1.1, "{hz} Hz → bar {bar} ({lo:.0}–{hi:.0} Hz)");
            assert!(features.spectrum.iter().all(|v| (0.0..=1.0).contains(v)), "{:?}", features.spectrum);
            assert!(features.spectrum[bar] > 0.9, "{:?}", features.spectrum);
        }
    }

    #[test]
    fn spectrum_bars_fall_gradually_after_a_tone() {
        let mut analyzer = Analyzer::default();
        let loud = run(&mut analyzer, &sine(1_000.0, 0.5, 0.5));
        let bar = loudest_bar(&loud);
        // Quiet but not silent: the bar drops by at most FALL per block.
        let after = analyzer.process(&vec![1e-3; BLOCK]);
        assert!(after.spectrum[bar] >= loud.spectrum[bar] - SPECTRUM_FALL - 1e-6, "{} → {}", loud.spectrum[bar], after.spectrum[bar]);
    }

    #[test]
    fn steady_tone_has_no_beats() {
        let features = run(&mut Analyzer::default(), &sine(60.0, 0.5, 3.0));
        assert!(features.beats <= 1, "beats: {}", features.beats);
    }
}
