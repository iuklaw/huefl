// Time zone helpers. Schedules run on the bridge, in the bridge's time zone,
// which need not be the computer's — so times are shown in that zone.

import { locale } from "@/i18n";

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormat(timeZone: string): Intl.DateTimeFormat {
  let format = partsCache.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, format);
  }
  return format;
}

/** The zone's UTC offset in minutes at `ms` (DST aware); 0 for unknown zones. */
export function zoneOffset(timeZone: string, ms: number): number {
  try {
    const p = Object.fromEntries(partsFormat(timeZone).formatToParts(ms).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}

/** "07:30" in the zone. */
export function formatClock(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  } catch {
    return new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
}

/** "Wed 07:30" when not today (in the zone), else "07:30". */
export function formatWhen(ms: number, now: number, timeZone: string): string {
  const day = (t: number) => Math.floor((t + zoneOffset(timeZone, t) * 60_000) / 86_400_000);
  if (day(ms) === day(now)) return formatClock(ms, timeZone);
  try {
    const weekday = new Intl.DateTimeFormat(locale, { timeZone, weekday: "short" }).format(ms);
    return `${weekday} ${formatClock(ms, timeZone)}`;
  } catch {
    return formatClock(ms, timeZone);
  }
}

/** "12:34" / "1:02:03" countdown. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
