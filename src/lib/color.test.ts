import { describe, expect, it } from "vitest";
import { hexToRgb, hueOf, paletteFromColor } from "./color";

const hueDistance = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe("paletteFromColor", () => {
  const today = "#545575"; // a real one: dim, greyish blue

  it("one light gets the color itself", () => {
    const [only] = paletteFromColor("#3366cc", 1);
    expect(only).toBe("#3366CC");
  });

  it("one color per light, all different", () => {
    for (const n of [2, 3, 5, 8]) {
      const colors = paletteFromColor(today, n);
      expect(colors).toHaveLength(n);
      expect(new Set(colors).size).toBe(n);
    }
  });

  it("stays close to the color's hue", () => {
    const base = hueOf(today);
    for (const color of paletteFromColor(today, 10)) {
      expect(hueDistance(hueOf(color), base)).toBeLessThanOrEqual(41);
    }
  });

  it("keeps the middle light on the color's hue", () => {
    const colors = paletteFromColor(today, 5);
    expect(hueDistance(hueOf(colors[2]!), hueOf(today))).toBeLessThan(2);
  });

  it("lifts grey, dark colors enough for a lamp to show them", () => {
    for (const color of paletteFromColor("#1a1a1c", 4)) {
      const { r, g, b } = hexToRgb(color);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      expect(max).toBeGreaterThan(60);
      expect(max - min).toBeGreaterThan(20); // not grey
    }
  });

  it("wraps around red", () => {
    const base = hueOf("#ff0010");
    for (const color of paletteFromColor("#ff0010", 6)) {
      expect(hueDistance(hueOf(color), base)).toBeLessThanOrEqual(41);
    }
  });
});
