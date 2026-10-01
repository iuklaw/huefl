// Day and night over the chosen place, as a clock: one arc from the
// bottom-left corner to the bottom-right one, the same everywhere on Earth.
// By day the sun walks it from sunrise to sunset; by night the moon walks it
// from sunset to the next sunrise - by time, not by where they are in the sky
// (true positions loop near the tropics and hide below the horizon). So
// there's always one of them on the arc; the moon shows its real phase.
// Below: sunrise, a live countdown to the next sunrise or sunset, sunset.
// Sun schedules within the current day or night show as marks on the arc.

import { useMemo } from "react";
import { scheduleLocation, useSchedules, nextRunOf, roomOf } from "@/core/schedules";
import { useAppState } from "@/core/useAppState";
import { t, type MessageKey } from "@/i18n";
import { currentPass, dayPart, moonPhase, sunAt } from "@/lib/sun";
import { formatClock, formatCountdown } from "@/lib/time";
import { describeSun, useNow } from "./describe";

const W = 400;
const H = 124;
const HORIZON = 112;
const SUN_R = 8;
const MOON_R = 6.5;
/** Where the arc meets the horizon, from the sides. */
const EDGE = 6;
/** Rise and set are recomputed this often; positions and the countdown every second. */
const PASS_REFRESH_MS = 30_000;

// The arc: a quarter of a circle, leaving the horizon at 45° in the bottom-left
// corner and coming back down at 45° in the bottom-right one (a tangent at 45°
// at both ends means the arc spans 90° of its circle).
const HALF_CHORD = W / 2 - EDGE;
const RADIUS = HALF_CHORD / Math.SQRT1_2;
const CENTER = { x: W / 2, y: HORIZON + HALF_CHORD }; // R·cos 45° below the horizon

/** A point on the arc, `t` 0 (rise, left) … 1 (set, right), evenly along its length. */
function onArc(t: number): { x: number; y: number } {
  const angle = (t - 0.5) * (Math.PI / 2); // −45° … +45° from straight up
  return { x: CENTER.x + RADIUS * Math.sin(angle), y: CENTER.y - RADIUS * Math.cos(angle) };
}

const ARC = `M ${EDGE} ${HORIZON} A ${RADIUS} ${RADIUS} 0 0 1 ${W - EDGE} ${HORIZON}`;


export function SunArc() {
  useAppState(); // the location may change
  const { automations } = useSchedules();
  const now = useNow(1_000);
  const tick = Math.floor(now / PASS_REFRESH_MS);
  const place = scheduleLocation();
  const zone = place.timeZone;

  const sky = useMemo(() => {
    const at = tick * PASS_REFRESH_MS;
    return { sun: currentPass("sun", at, place), part: dayPart(at, place) };
  }, [tick, place.lat, place.lon]);

  const sun = sunAt(now, place.lat, place.lon);
  const phase = moonPhase(now);
  // How far through the day (or night) we are; the middle in polar day / night.
  const { part, start, end } = sky.part;
  const along = (ms: number) =>
    start === null || end === null ? 0.5 : Math.min(1, Math.max(0, (ms - start) / (end - start)));
  const body = onArc(along(now));

  // Sky color follows the sun: night, golden hour, day.
  const light = Math.min(1, Math.max(0, (sun.altitude + 8) / 16));
  const skyTop = mix([22, 27, 60], [96, 165, 250], light);
  const skyLow = mix([49, 46, 129], sun.altitude < 8 ? [251, 146, 60] : [186, 230, 253], light);

  // The sun's current pass (or the next one at night) gives both times.
  const { rise, set } = sky.sun;
  const marks = automations
    .filter((a) => a.trigger.kind === "sun" && a.enabled)
    .map((a) => {
      const at = nextRunOf(a, now);
      // Only what falls in this day (or night) has a place on the arc.
      if (!at || start === null || end === null || at > end) return null;
      const trigger = a.trigger as Extract<typeof a.trigger, { kind: "sun" }>;
      const room = roomOf(a)?.name ?? a.name;
      return {
        id: `${a.source}:${a.id}`,
        ...onArc(along(at)),
        label: `${room} · ${t(a.action.on ? "schedule.action.on" : "schedule.action.off")} · ${describeSun(trigger)} · ${formatClock(at, zone)}`,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const countdown =
    rise !== null && now < rise
      ? t("schedule.sky.sunrise_in", { time: formatCountdown(rise - now) })
      : set !== null && now < set
        ? t("schedule.sky.sunset_in", { time: formatCountdown(set - now) })
        : t(sun.altitude > 0 ? "schedule.sky.polar_day" : "schedule.sky.polar_night");
  const phaseLabel = `${t(`schedule.moon.${moonPhaseName(phase.phase)}` as MessageKey)} · ${Math.round(phase.fraction * 100)}%`;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={t("schedule.sky.label")}>
        <defs>
          <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={rgb(skyTop)} stopOpacity={0.55} />
            <stop offset="1" stopColor={rgb(skyLow)} stopOpacity={0.35} />
          </linearGradient>
          <radialGradient id="sun-glow">
            <stop offset="0" stopColor="#FDE68A" stopOpacity={0.9} />
            <stop offset="1" stopColor="#FDB813" stopOpacity={0} />
          </radialGradient>
          <clipPath id="above">
            <rect width={W} height={HORIZON} />
          </clipPath>
        </defs>

        <rect width={W} height={HORIZON} fill="url(#sky)" />
        {/* Stars, fading in as the sun goes down. */}
        <g fill="white" opacity={Math.max(0, 1 - light * 1.6) * 0.8}>
          {STARS.map(([sx, sy, r], i) => (
            <circle key={i} cx={sx} cy={sy} r={r} />
          ))}
        </g>

        <g clipPath="url(#above)">
          <path
            d={ARC}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="2 4"
            strokeLinecap="round"
            className={part === "day" ? "stroke-amber-400/70" : "stroke-slate-400/50"}
          />
          {part === "night" ? (
            <g>
              <title>{phaseLabel}</title>
              <MoonGlyph cx={body.x} cy={body.y} fraction={phase.fraction} waxing={phase.phase < 0.5} />
            </g>
          ) : (
            <g>
              <circle cx={body.x} cy={body.y} r={SUN_R * 3} fill="url(#sun-glow)" />
              <circle cx={body.x} cy={body.y} r={SUN_R} fill="#FDB813" />
            </g>
          )}
        </g>

        {/* Ground and horizon. */}
        <rect y={HORIZON} width={W} height={H - HORIZON} className="fill-muted" />
        <line x1={0} x2={W} y1={HORIZON} y2={HORIZON} className="stroke-border" strokeWidth={1.5} />

        {marks.map((m) => (
          <g key={m.id}>
            <title>{m.label}</title>
            <rect x={m.x - 3.5} y={m.y - 3.5} width={7} height={7} transform={`rotate(45 ${m.x} ${m.y})`} className="fill-primary stroke-card" />
          </g>
        ))}
      </svg>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums" title={t("schedule.sun.sunrise")}>
          {rise !== null && `↑ ${formatClock(rise, zone)}`}
        </span>
        <span className="text-center font-medium text-foreground tabular-nums" aria-live="off">
          {countdown}
        </span>
        <span className="text-right tabular-nums" title={t("schedule.sun.sunset")}>
          {set !== null && `↓ ${formatClock(set, zone)}`}
        </span>
      </div>
    </div>
  );
}

/** The moon with its lit part: waxing lit on the right (northern hemisphere view). */
function MoonGlyph({ cx, cy, fraction, waxing }: { cx: number; cy: number; fraction: number; waxing: boolean }) {
  const r = MOON_R;
  const rx = r * Math.abs(1 - 2 * fraction);
  const gibbous = fraction > 0.5;
  // SVG's y points down, so sweep 1 = clockwise on screen. The limb runs top →
  // bottom along the lit edge; the terminator comes back up, bulging toward
  // the lit edge for a crescent and away from it past half.
  const limbSweep = waxing ? 1 : 0;
  const termSweep = waxing ? (gibbous ? 1 : 0) : gibbous ? 0 : 1;
  const lit = `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${limbSweep} ${cx} ${cy + r} A ${rx} ${r} 0 0 ${termSweep} ${cx} ${cy - r} Z`;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r * 2.2} fill="#E2E8F0" opacity={0.12} />
      <circle cx={cx} cy={cy} r={r} fill="#334155" />
      <path d={lit} fill="#E2E8F0" />
    </g>
  );
}

function moonPhaseName(phase: number): string {
  const names = ["new", "waxing_crescent", "first_quarter", "waxing_gibbous", "full", "waning_gibbous", "last_quarter", "waning_crescent"];
  return names[Math.round(phase * 8) % 8]!;
}

function mix(a: number[], b: number[], k: number): number[] {
  return a.map((v, i) => Math.round(v + (b[i]! - v) * k));
}

function rgb([r, g, b]: number[]): string {
  return `rgb(${r} ${g} ${b})`;
}

// A fixed sprinkle of stars (x, y, radius).
const STARS: [number, number, number][] = [
  [22, 18, 0.8], [58, 44, 0.6], [91, 12, 1], [130, 38, 0.7], [164, 20, 0.6], [201, 50, 0.9],
  [238, 14, 0.6], [270, 36, 1], [305, 22, 0.7], [338, 48, 0.6], [372, 16, 0.9], [44, 70, 0.6],
  [114, 76, 0.7], [182, 84, 0.6], [252, 72, 0.8], [322, 80, 0.6], [386, 66, 0.7],
];
