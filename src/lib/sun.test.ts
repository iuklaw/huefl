import { describe, expect, it } from "vitest";
import { currentPass, dayPart, moonAt, sunTimes } from "./sun";

const WARSAW = { lat: 52.25, lon: 21 };
const MINUTE = 60_000;

describe("currentPass", () => {
  it("the sun at noon: today's rise to set", () => {
    const noon = Date.UTC(2026, 8, 29, 10, 30); // 12:30 in Warsaw
    const pass = currentPass("sun", noon, WARSAW);
    const times = sunTimes(noon, WARSAW.lat, WARSAW.lon, "Europe/Warsaw");
    expect(Math.abs(pass.rise! - times.sunrise!)).toBeLessThan(2 * MINUTE);
    expect(Math.abs(pass.set! - times.sunset!)).toBeLessThan(2 * MINUTE);
  });

  it("the sun after sunset: tomorrow's pass", () => {
    const evening = Date.UTC(2026, 8, 29, 20, 0); // 22:00 in Warsaw
    const pass = currentPass("sun", evening, WARSAW);
    expect(pass.rise!).toBeGreaterThan(evening);
    const tomorrow = sunTimes(evening + 12 * 3_600_000, WARSAW.lat, WARSAW.lon, "Europe/Warsaw");
    expect(Math.abs(pass.rise! - tomorrow.sunrise!)).toBeLessThan(2 * MINUTE);
  });

  it("the moon: one unbroken pass around now", () => {
    const now = Date.UTC(2026, 8, 29, 20, 30);
    const pass = currentPass("moon", now, WARSAW);
    expect(pass.rise).not.toBeNull();
    expect(pass.set).not.toBeNull();
    if (moonAt(now, WARSAW.lat, WARSAW.lon).altitude > 0) {
      expect(pass.rise!).toBeLessThan(now);
      expect(pass.set!).toBeGreaterThan(now);
    } else {
      expect(pass.rise!).toBeGreaterThan(now);
    }
    // Continuous: no gaps between samples, everything above the horizon.
    const gaps = pass.points.slice(1).map((p, i) => p.ms - pass.points[i]!.ms);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(10 * MINUTE);
    expect(Math.min(...pass.points.map((p) => p.position.altitude))).toBeGreaterThan(-1);
  });
});

describe("dayPart", () => {
  it("day runs from this morning's sunrise to this evening's sunset", () => {
    const noon = Date.UTC(2026, 8, 29, 10, 30);
    const times = sunTimes(noon, WARSAW.lat, WARSAW.lon, "Europe/Warsaw");
    const part = dayPart(noon, WARSAW);
    expect(part.part).toBe("day");
    expect(Math.abs(part.start! - times.sunrise!)).toBeLessThan(2 * MINUTE);
    expect(Math.abs(part.end! - times.sunset!)).toBeLessThan(2 * MINUTE);
  });

  it("night runs from this evening's sunset to tomorrow's sunrise", () => {
    const evening = Date.UTC(2026, 8, 29, 20, 0);
    const today = sunTimes(evening, WARSAW.lat, WARSAW.lon, "Europe/Warsaw");
    const tomorrow = sunTimes(evening + 12 * 3_600_000, WARSAW.lat, WARSAW.lon, "Europe/Warsaw");
    const part = dayPart(evening, WARSAW);
    expect(part.part).toBe("night");
    expect(Math.abs(part.start! - today.sunset!)).toBeLessThan(2 * MINUTE);
    expect(Math.abs(part.end! - tomorrow.sunrise!)).toBeLessThan(2 * MINUTE);
  });

  it("polar night has no edges", () => {
    const part = dayPart(Date.UTC(2026, 11, 21, 12), { lat: 80, lon: 15 });
    expect(part).toEqual({ part: "night", start: null, end: null });
  });
});
