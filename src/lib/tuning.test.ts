import { describe, expect, it } from "vitest";
import { applyPatch, presetTuning, sanitizeTuning, toEngine, tuningForAll } from "./tuning";

describe("presetTuning", () => {
  it("step k sits at k/3 - what Rust reads as the old intensity step", () => {
    for (const level of [0, 1, 2, 3] as const) {
      const engine = toEngine(presetTuning("screen", level));
      expect(engine.speed).toBeCloseTo(level / 3, 6);
      expect(engine.vividness).toBeCloseTo(level / 3, 6);
    }
  });

  it("palettes keep their colors; music keeps a little light", () => {
    expect(presetTuning("ambient", 3).vividness).toBe(50);
    expect(presetTuning("music", 0).brightness).toEqual([5, 100]);
    expect(presetTuning("screen", 2).brightness).toEqual([0, 100]);
  });
});

describe("applyPatch", () => {
  it("a hand-made change makes the settings Custom", () => {
    const tuned = applyPatch(presetTuning("music", 2), { speed: 80 });
    expect(tuned.intensity).toBeNull();
    expect(tuned.speed).toBe(80);
    expect(tuned.brightness).toEqual([5, 100]);
  });
});

describe("sanitizeTuning", () => {
  it("settings from before per-mode tuning start every mode from their intensity", () => {
    expect(sanitizeTuning(undefined, 3)).toEqual(tuningForAll(3));
  });

  it("without anything stored: Medium", () => {
    expect(sanitizeTuning(undefined, undefined)).toEqual(tuningForAll(1));
  });

  it("keeps stored settings and repairs broken values", () => {
    const fixed = sanitizeTuning(
      {
        music: { intensity: null, brightness: [60, 20], speed: 140, vividness: Number.NaN, sensitivity: 70 },
      },
      undefined,
    );
    expect(fixed.music).toEqual({
      intensity: null,
      brightness: [60, 60],
      speed: 100,
      vividness: 50,
      sensitivity: 70,
    });
    expect(fixed.screen).toEqual(presetTuning("screen", 1));
  });
});
