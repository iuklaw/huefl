// The sync settings: Brightness (a range), Speed, Vividness, Sensitivity -
// one set per mode. Intensity is a quick preset that sets all of them;
// moving any setting by hand makes it Custom.
//
// Positions are 0..100 here and 0..1 in Rust, where each mode decides what a
// position means (src-tauri/src/sync/tuning.rs). Step k of Intensity sits at
// k/3 of the way, which reproduces what Intensity did before these settings.

import type { IntensityLevel, SyncMode, SyncTuning } from "@/types";

export const INTENSITY_LEVELS: IntensityLevel[] = [0, 1, 2, 3];
export const SYNC_MODES: SyncMode[] = ["ambient", "music", "screen"];

export function presetTuning(mode: SyncMode, level: IntensityLevel): SyncTuning {
  const step = (level * 100) / 3;
  return {
    intensity: level,
    // Music has always kept a little light in quiet passages.
    brightness: mode === "music" ? [5, 100] : [0, 100],
    speed: step,
    // Only the screen's colors were boosted by intensity; palettes stay as they are.
    vividness: mode === "screen" ? step : 50,
    sensitivity: 50,
  };
}

/** A hand-made change: the settings no longer match a preset. */
export function applyPatch(
  tuning: SyncTuning,
  patch: Partial<Omit<SyncTuning, "intensity">>,
): SyncTuning {
  return { ...tuning, ...patch, intensity: null };
}

/** Every mode at one Intensity step - for settings from before per-mode tuning. */
export function tuningForAll(level: IntensityLevel): Record<SyncMode, SyncTuning> {
  return {
    ambient: presetTuning("ambient", level),
    music: presetTuning("music", level),
    screen: presetTuning("screen", level),
  };
}

/** Stored settings, with anything missing or out of range repaired. */
export function sanitizeTuning(
  saved: Partial<Record<SyncMode, Partial<SyncTuning>>> | undefined,
  legacyIntensity: unknown,
): Record<SyncMode, SyncTuning> {
  const level = INTENSITY_LEVELS.includes(legacyIntensity as IntensityLevel)
    ? (legacyIntensity as IntensityLevel)
    : 1;
  const fallback = tuningForAll(level);
  const clamp = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : d;

  const one = (mode: SyncMode): SyncTuning => {
    const s = saved?.[mode];
    const d = fallback[mode];
    if (!s) return d;
    const [lo, hi] = Array.isArray(s.brightness) ? s.brightness : d.brightness;
    const min = clamp(lo, d.brightness[0]);
    return {
      intensity: INTENSITY_LEVELS.includes(s.intensity as IntensityLevel)
        ? (s.intensity as IntensityLevel)
        : null,
      brightness: [min, Math.max(min, clamp(hi, d.brightness[1]))],
      speed: clamp(s.speed, d.speed),
      vividness: clamp(s.vividness, d.vividness),
      sensitivity: clamp(s.sensitivity, d.sensitivity),
    };
  };
  return { ambient: one("ambient"), music: one("music"), screen: one("screen") };
}

/** What Rust's sync_start / sync_tune take (src-tauri/src/sync/tuning.rs). */
export type EngineTuning = {
  brightnessMin: number;
  brightnessMax: number;
  speed: number;
  vividness: number;
  sensitivity: number;
};

export function toEngine(tuning: SyncTuning): EngineTuning {
  return {
    brightnessMin: tuning.brightness[0] / 100,
    brightnessMax: tuning.brightness[1] / 100,
    speed: tuning.speed / 100,
    vividness: tuning.vividness / 100,
    sensitivity: tuning.sensitivity / 100,
  };
}
