// Sun and moon for the schedule: rise and set times, where they are in the
// sky, the moon's phase. A thin layer over suncalc (positions from the
// astronomical formulas; within a minute or so of the bridge's own
// sunrise/sunset, which drives the actual rules).

import * as SunCalc from "suncalc";
import { EVERY_DAY, WEEKDAYS } from "@/hue/schedules";
import { zoneOffset } from "@/lib/time";

export type SkyPosition = {
  /** Degrees above the horizon (negative below). */
  altitude: number;
  /** Degrees from south, west positive: east −90, west +90, north ±180. */
  azimuth: number;
};

export type MoonPhase = {
  /** Lit part of the disc, 0–1. */
  fraction: number;
  /** 0 new → 0.25 first quarter → 0.5 full → 0.75 last quarter. */
  phase: number;
};

/** suncalc 2 gives degrees, azimuth clockwise from north; ours is from south. */
function fromSuncalc(p: { altitude: number; azimuth: number }): SkyPosition {
  return { altitude: p.altitude, azimuth: p.azimuth - 180 };
}

export function sunAt(ms: number, lat: number, lon: number): SkyPosition {
  return fromSuncalc(SunCalc.getPosition(new Date(ms), lat, lon));
}

export function moonAt(ms: number, lat: number, lon: number): SkyPosition {
  return fromSuncalc(SunCalc.getMoonPosition(new Date(ms), lat, lon));
}

export function moonPhase(ms: number): MoonPhase {
  const m = SunCalc.getMoonIllumination(new Date(ms));
  return { fraction: m.fraction, phase: m.phase };
}

/** Midnight starting the day that contains `ms`, in `timeZone`. */
export function dayStart(ms: number, timeZone: string): number {
  const local = ms + zoneOffset(timeZone, ms) * 60_000;
  const midnightLocal = Math.floor(local / 86_400_000) * 86_400_000;
  return midnightLocal - zoneOffset(timeZone, midnightLocal) * 60_000;
}

export type SunTimes = { sunrise: number | null; sunset: number | null; noon: number };

/** Sunrise and sunset of the day containing `ms` (null in polar day / night). */
export function sunTimes(ms: number, lat: number, lon: number, timeZone: string): SunTimes {
  // suncalc takes any moment of the day; local noon avoids date-line surprises.
  const noon = dayStart(ms, timeZone) + 12 * 3_600_000;
  const times = SunCalc.getTimes(new Date(noon), lat, lon);
  const valid = (d: Date | null) => (d && Number.isFinite(d.getTime()) ? d.getTime() : null);
  return { sunrise: valid(times.sunrise), sunset: valid(times.sunset), noon: times.solarNoon.getTime() };
}

/**
 * The next time a sun rule fires after `from`: the event plus the offset, on
 * an allowed weekday (weekdays counted in `timeZone`, the bridge's zone).
 */
export function nextSunEvent(
  event: "sunrise" | "sunset",
  offsetMinutes: number,
  days: number,
  from: number,
  place: { lat: number; lon: number },
  timeZone: string,
): number | null {
  const today = dayStart(from, timeZone);
  for (let day = 0; day <= 8; day++) {
    const noon = today + day * 86_400_000 + 12 * 3_600_000;
    const at = sunTimes(noon, place.lat, place.lon, timeZone)[event];
    if (at === null) continue;
    const fires = at + offsetMinutes * 60_000;
    if (fires <= from) continue;
    if (days !== EVERY_DAY && days !== 0) {
      const local = fires + zoneOffset(timeZone, fires) * 60_000;
      const weekday = (new Date(local).getUTCDay() + 6) % 7; // Monday = 0
      if (!(days & WEEKDAYS[weekday]!)) continue;
    }
    return fires;
  }
  return null;
}

/** One trip of a body across the sky: from rise to set, sampled along the way. */
export type Pass = {
  /** Null when it doesn't rise / set within a day and a half (polar day or night). */
  rise: number | null;
  set: number | null;
  points: { ms: number; position: SkyPosition }[];
};

// Rise and set: the upper limb touches the horizon. suncalc's altitudes are
// apparent (refraction already in), so that's the centre half a disc below.
const HORIZON_ALTITUDE = { sun: -0.27, moon: -0.27 };
const SEARCH_MS = 36 * 3_600_000;

/**
 * The pass going on now, or the next one if the body is below the horizon -
 * one continuous arc, unlike a calendar day, which cuts the moon's trip in
 * two when it crosses midnight.
 */
export function currentPass(
  body: "sun" | "moon",
  now: number,
  place: { lat: number; lon: number },
  stepMinutes = 10,
): Pass {
  const at = body === "sun" ? sunAt : moonAt;
  const step = stepMinutes * 60_000;
  const height = (ms: number) => at(ms, place.lat, place.lon).altitude - HORIZON_ALTITUDE[body];
  // Where the altitude crosses the horizon between a (below) and b (above), or back.
  const crossing = (a: number, b: number) => {
    const [ha, hb] = [height(a), height(b)];
    return ha === hb ? a : a + ((b - a) * ha) / (ha - hb);
  };

  let rise: number | null = null;
  if (height(now) > 0) {
    for (let t = now; t > now - SEARCH_MS; t -= step) {
      if (height(t - step) <= 0) {
        rise = crossing(t - step, t);
        break;
      }
    }
  } else {
    for (let t = now; t < now + SEARCH_MS; t += step) {
      if (height(t + step) > 0) {
        rise = crossing(t, t + step);
        break;
      }
    }
  }

  let set: number | null = null;
  if (rise !== null) {
    for (let t = rise; t < rise + SEARCH_MS; t += step) {
      if (height(t + step) <= 0) {
        set = crossing(t, t + step);
        break;
      }
    }
  }

  const [start, end] =
    rise !== null && set !== null ? [rise, set] : [now - 12 * 3_600_000, now + 12 * 3_600_000];
  const points: Pass["points"] = [];
  for (let ms = start; ms < end; ms += step) points.push({ ms, position: at(ms, place.lat, place.lon) });
  points.push({ ms: end, position: at(end, place.lat, place.lon) });
  return { rise: set !== null ? rise : null, set, points };
}

/** The stretch of day or night we're in: from the last sunrise (sunset) to the next sunset (sunrise). */
export type DayPart = {
  part: "day" | "night";
  /** Null in polar day or night: no sunrise / sunset within a day and a half. */
  start: number | null;
  end: number | null;
};

export function dayPart(now: number, place: { lat: number; lon: number }, stepMinutes = 10): DayPart {
  const step = stepMinutes * 60_000;
  const height = (ms: number) => sunAt(ms, place.lat, place.lon).altitude - HORIZON_ALTITUDE.sun;
  const up = height(now) > 0;
  // The first time, going `direction` from now, the sun is on the other side of the horizon.
  const edge = (direction: 1 | -1): number | null => {
    for (let t = now; Math.abs(t - now) < SEARCH_MS; t += direction * step) {
      const next = t + direction * step;
      if (height(next) > 0 !== up) {
        const [ha, hb] = [height(t), height(next)];
        return ha === hb ? t : t + ((next - t) * ha) / (ha - hb);
      }
    }
    return null;
  };
  const [start, end] = [edge(-1), edge(1)];
  return start !== null && end !== null
    ? { part: up ? "day" : "night", start, end }
    : { part: up ? "day" : "night", start: null, end: null };
}
