// Small form controls for the schedule editor.

import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WEEKDAYS } from "@/hue/schedules";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WEEKDAY_NAMES } from "./describe";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</h3>
      {children}
    </section>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="grid gap-1 rounded-lg bg-muted p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="radiogroup"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === option.value
              ? "bg-background font-medium shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Weekday toggles, Monday first; nothing selected = once. */
export function DayChips({
  days,
  onChange,
  allowOnce = true,
}: {
  days: number;
  onChange: (days: number) => void;
  allowOnce?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((bit, i) => {
          const on = Boolean(days & bit);
          return (
            <button
              key={bit}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const next = days ^ bit;
                if (next !== 0 || allowOnce) onChange(next);
              }}
              className={cn(
                "rounded-md border py-1 text-[11px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-primary bg-primary/15 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {WEEKDAY_NAMES[i]}
            </button>
          );
        })}
      </div>
      {allowOnce && days === 0 && <p className="text-[11px] text-muted-foreground">{t("schedule.editor.once_hint")}</p>}
    </div>
  );
}

/** HH : MM with steppers - WebKitGTK's own time input is bare. */
export function TimeField({
  hour,
  minute,
  onChange,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
}) {
  const shift = (minutes: number) => {
    const total = (((hour * 60 + minute + minutes) % 1440) + 1440) % 1440;
    onChange(Math.floor(total / 60), total % 60);
  };
  return (
    <div className="flex items-center justify-center gap-2">
      <Stepper label={t("schedule.editor.hour")} value={hour} max={23} onChange={(h) => onChange(h, minute)} step={() => shift(60)} back={() => shift(-60)} />
      <span className="text-2xl font-semibold tabular-nums text-muted-foreground">:</span>
      <Stepper label={t("schedule.editor.minute")} value={minute} max={59} onChange={(m) => onChange(hour, m)} step={() => shift(5)} back={() => shift(-5)} />
    </div>
  );
}

/** A length of time as H : MM, looking like TimeField; kept within 1 min … `maxMinutes`. */
export function DurationField({
  minutes,
  maxMinutes,
  onChange,
}: {
  minutes: number;
  maxMinutes: number;
  onChange: (minutes: number) => void;
}) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const set = (total: number) => onChange(Math.min(maxMinutes, Math.max(1, total)));
  return (
    <div className="flex items-center justify-center gap-2">
      <Stepper
        label={t("schedule.editor.hours")}
        value={hours}
        max={Math.floor(maxMinutes / 60)}
        onChange={(h) => set(h * 60 + rest)}
        step={() => set(minutes + 60)}
        back={() => set(minutes - 60)}
      />
      <span className="text-2xl font-semibold tabular-nums text-muted-foreground">:</span>
      <Stepper
        label={t("schedule.editor.minutes")}
        value={rest}
        max={59}
        onChange={(m) => set(hours * 60 + m)}
        step={() => set(minutes + 5)}
        back={() => set(minutes - 5)}
      />
    </div>
  );
}

function Stepper({
  label,
  value,
  max,
  onChange,
  step,
  back,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
  step: () => void;
  back: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button size="icon-xs" variant="ghost" aria-label={`${label} −`} onClick={back}>
        <Minus />
      </Button>
      <input
        aria-label={label}
        inputMode="numeric"
        value={String(value).padStart(2, "0")}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(-2);
          if (digits) onChange(Math.min(max, Number(digits)));
        }}
        onFocus={(event) => event.target.select()}
        className="w-11 rounded-md border border-input bg-transparent py-1 text-center text-2xl font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button size="icon-xs" variant="ghost" aria-label={`${label} +`} onClick={step}>
        <Plus />
      </Button>
    </div>
  );
}
