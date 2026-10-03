// Human-readable schedules: "Weekdays 07:30", "On at 80% · fade 10 min".

import { useEffect, useState } from "react";
import { EVERY_DAY, WEEKDAYS, type Automation, type ScheduleAction, type Trigger } from "@/hue/schedules";
import { t } from "@/i18n";
import { locale } from "@/i18n";

const WEEKDAY_MASK = 64 | 32 | 16 | 8 | 4;
const WEEKEND_MASK = 2 | 1;

/** Longest timer offered (12 h); the bridge counts down up to 99 h. */
export const MAX_TIMER_MINUTES = 720;

/** A typed-in timer length made valid: whole minutes, 1 … MAX_TIMER_MINUTES. */
export function clampMinutes(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_TIMER_MINUTES, Math.max(1, Math.round(value))) : 1;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return t("duration.minutes", { m });
  return m === 0 ? t("duration.hours", { h }) : t("duration.hours_minutes", { h, m });
}

/** Short weekday names, Monday first ("Mon", "Tue", …). */
export const WEEKDAY_NAMES: string[] = WEEKDAYS.map((_, i) =>
  // 2024-01-01 was a Monday.
  new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2024, 0, 1 + i)),
);

export function describeDays(days: number): string {
  if (days === 0) return t("schedule.days.once");
  if (days === EVERY_DAY) return t("schedule.days.every");
  if (days === WEEKDAY_MASK) return t("schedule.days.weekdays");
  if (days === WEEKEND_MASK) return t("schedule.days.weekends");
  return WEEKDAYS.flatMap((bit, i) => (days & bit ? [WEEKDAY_NAMES[i]!] : [])).join(", ");
}

export function describeAction(action: ScheduleAction): string {
  const base = !action.on
    ? t("schedule.action.off")
    : action.brightness !== undefined
      ? t("schedule.action.on_at", { brightness: action.brightness })
      : t("schedule.action.on");
  return action.fadeMinutes ? base + t("schedule.fade_suffix", { duration: formatDuration(action.fadeMinutes) }) : base;
}

/** "Sunset +30 min", "2 h before sunrise", "Sunset". */
export function describeSun(trigger: Extract<Trigger, { kind: "sun" }>): string {
  const event = t(`schedule.sun.${trigger.event}`);
  const offset = trigger.offsetMinutes;
  if (offset === 0) return event;
  const duration = formatDuration(Math.abs(offset));
  return t(offset > 0 ? "schedule.sun.after" : "schedule.sun.before", { duration, event: event.toLowerCase() });
}

/** When, without the room: "Weekdays · 07:30", "Timer · 15 min", "Every day · Sunset +30 min". */
export function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case "time": {
      const time = `${String(trigger.hour).padStart(2, "0")}:${String(trigger.minute).padStart(2, "0")}`;
      const random = trigger.randomMinutes ? t("schedule.random_suffix", { minutes: trigger.randomMinutes }) : "";
      return `${describeDays(trigger.days)} · ${time}${random}`;
    }
    case "timer":
      return t("schedule.kind.timer") + ` · ${formatDuration(trigger.minutes)}`;
    case "sun":
      return `${describeDays(trigger.days)} · ${describeSun(trigger)}`;
  }
}

export function describe(automation: Automation): string {
  return `${describeTrigger(automation.trigger)} -> ${describeAction(automation.action)}`;
}

/** Re-renders every `interval` ms, for countdowns and the sun. */
export function useNow(interval = 1_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}
