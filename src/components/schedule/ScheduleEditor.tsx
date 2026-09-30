// New / edit schedule, in one dialog: which room, when (a time, a timer, the
// sun) and what happens (on, on at a brightness, off; optionally fading).
// Mounted once in App; opened through editor-store.

import { useEffect, useState } from "react";
import { Moon, Sunrise, Sunset, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppState } from "@/core/useAppState";
import { bridgeNow, scheduleLocation, schedules, useSchedules, type TimerMode } from "@/core/schedules";
import { EVERY_DAY, SUN_LEAD, type AutomationDraft, type Trigger } from "@/hue/schedules";
import { t } from "@/i18n";
import { nextSunEvent } from "@/lib/sun";
import { formatWhen, zoneOffset } from "@/lib/time";
import { cn } from "@/lib/utils";
import { DayChips, DurationField, Field, Segmented, TimeField } from "./controls";
import { describeSun, formatDuration, MAX_TIMER_MINUTES } from "./describe";
import { closeScheduleEditor, useEditorRequest } from "./editor-store";

type Kind = Trigger["kind"];

type Form = {
  roomId: string;
  kind: Kind;
  hour: number;
  minute: number;
  timeDays: number;
  random: boolean;
  timerMinutes: number;
  /** Timer: off in N, off for N (off now, on after), on in N, on for N (on now, off after). */
  timerMode: TimerMode;
  sunEvent: "sunrise" | "sunset";
  offset: number;
  sunDays: number;
  on: boolean;
  setBrightness: boolean;
  brightness: number;
  fade: number;
};

const TIMER_PRESETS = [5, 15, 30, 60, 90];
const FADES = [0, 1, 5, 10, 30, 60];
const RANDOM_MINUTES = 30;

export function ScheduleEditor() {
  const request = useEditorRequest();
  const { rooms } = useAppState();
  const { timeZone } = useSchedules();
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schedulable = rooms.filter((r) => r.v1GroupId);

  // A fresh form each time the editor opens.
  useEffect(() => {
    if (!request) return;
    setError(null);
    const existing = request.existing;
    const room =
      schedulable.find((r) => r.id === request.roomId) ??
      schedulable.find((r) => r.v1GroupId === existing?.groupId) ??
      schedulable[0];
    const nextHour = new Date(bridgeNow() + zoneOffset(timeZone, bridgeNow()) * 60_000).getUTCHours() + 1;
    const base: Form = {
      roomId: room?.id ?? "",
      kind: request.kind ?? existing?.trigger.kind ?? "time",
      hour: nextHour % 24,
      minute: 0,
      timeDays: EVERY_DAY,
      random: false,
      timerMinutes: 15,
      timerMode: room?.on ? "off_in" : "on_for",
      sunEvent: "sunset",
      offset: 0,
      sunDays: EVERY_DAY,
      on: !room?.on,
      setBrightness: false,
      brightness: 80,
      fade: 0,
    };
    if (existing) {
      const trigger = existing.trigger;
      Object.assign(base, {
        on: existing.action.on,
        setBrightness: existing.action.brightness !== undefined,
        brightness: existing.action.brightness ?? 80,
        fade: existing.action.fadeMinutes ?? 0,
      });
      if (trigger.kind === "time") {
        Object.assign(base, { hour: trigger.hour, minute: trigger.minute, timeDays: trigger.days, random: Boolean(trigger.randomMinutes) });
      } else if (trigger.kind === "timer") {
        Object.assign(base, { timerMinutes: trigger.minutes, timerMode: existing.action.on ? "on_in" : "off_in" });
      } else {
        Object.assign(base, { sunEvent: trigger.event, offset: trigger.offsetMinutes, sunDays: trigger.days });
      }
    }
    setForm(base);
    // Only when a new request comes in.
  }, [request]);

  if (!request || !form) return null;
  const room = schedulable.find((r) => r.id === form.roomId);
  const update = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const location = scheduleLocation();
  const now = bridgeNow();

  const trigger = (): Trigger => {
    switch (form.kind) {
      case "timer":
        return { kind: "timer", minutes: form.timerMinutes };
      case "sun":
        return { kind: "sun", event: form.sunEvent, offsetMinutes: form.offset, days: form.sunDays };
      default: {
        let date: string | undefined;
        if (form.timeDays === 0) {
          // Once: today if the time is still ahead (in the bridge's zone), else tomorrow.
          const local = new Date(now + zoneOffset(timeZone, now) * 60_000);
          const ahead = form.hour * 60 + form.minute > local.getUTCHours() * 60 + local.getUTCMinutes();
          const day = new Date(local.getTime() + (ahead ? 0 : 86_400_000));
          date = day.toISOString().slice(0, 10);
        }
        return {
          kind: "time",
          hour: form.hour,
          minute: form.minute,
          days: form.timeDays,
          ...(date ? { date } : {}),
          ...(form.random ? { randomMinutes: RANDOM_MINUTES } : {}),
        };
      }
    }
  };

  const save = async () => {
    if (!room?.v1GroupId) return;
    setSaving(true);
    setError(null);
    try {
      if (form.kind === "timer") {
        await schedules.startTimer(room, form.timerMinutes, form.timerMode);
      } else {
        const draft: AutomationDraft = {
          groupId: room.v1GroupId,
          name: room.name,
          trigger: trigger(),
          action: {
            on: form.on,
            ...(form.on && form.setBrightness ? { brightness: form.brightness } : {}),
            ...(form.fade ? { fadeMinutes: form.fade } : {}),
          },
          enabled: request.existing?.enabled ?? true,
        };
        await schedules.save(draft, request.existing);
      }
      closeScheduleEditor();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!request.existing) return;
    setSaving(true);
    try {
      await schedules.remove(request.existing);
      closeScheduleEditor();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const sunNext =
    form.kind === "sun" ? nextSunEvent(form.sunEvent, form.offset, form.sunDays, now, location, timeZone) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && closeScheduleEditor()}>
      <DialogContent className="gap-4 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t(request.existing ? "schedule.editor.title_edit" : "schedule.editor.title_new")}
          </DialogTitle>
          <DialogDescription className="text-xs">{t("schedule.editor.hint")}</DialogDescription>
        </DialogHeader>

        <Field label={t("schedule.editor.room")}>
          <Select value={form.roomId} onValueChange={(roomId) => update({ roomId })}>
            <SelectTrigger className="w-full text-xs font-medium" aria-label={t("schedule.editor.room")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {schedulable.map((r) => (
                <SelectItem key={r.id} value={r.id} className="text-xs font-medium">
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label={t("schedule.editor.when")}>
          <Tabs value={form.kind} onValueChange={(kind) => update({ kind: kind as Kind })}>
            <TabsList className="w-full">
              <TabsTrigger value="time" className="text-xs">
                {t("schedule.kind.time")}
              </TabsTrigger>
              <TabsTrigger value="timer" className="text-xs">
                <Timer />
                {t("schedule.kind.timer")}
              </TabsTrigger>
              <TabsTrigger value="sun" className="text-xs">
                <Sunset />
                {t("schedule.kind.sun")}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {form.kind === "time" && (
            <div className="space-y-3 pt-1">
              <TimeField hour={form.hour} minute={form.minute} onChange={(hour, minute) => update({ hour, minute })} />
              <DayChips days={form.timeDays} onChange={(timeDays) => update({ timeDays })} />
              <label className="flex items-center justify-between gap-2 text-xs">
                <span>
                  {t("schedule.editor.random")}
                  <span className="block text-[11px] text-muted-foreground">{t("schedule.editor.random_hint")}</span>
                </span>
                <Switch checked={form.random} onCheckedChange={(random) => update({ random })} />
              </label>
            </div>
          )}

          {form.kind === "timer" && (
            <div className="space-y-3 pt-1">
              <Segmented
                options={[
                  { value: "off_in", label: t("schedule.editor.timer_off") },
                  { value: "off_for", label: t("schedule.editor.timer_off_for") },
                  { value: "on_in", label: t("schedule.editor.timer_on_in") },
                  { value: "on_for", label: t("schedule.editor.timer_on") },
                ]}
                value={form.timerMode}
                onChange={(timerMode) => update({ timerMode })}
              />
              <div className="flex flex-wrap justify-center gap-1">
                {TIMER_PRESETS.map((minutes) => (
                  <Button
                    key={minutes}
                    size="xs"
                    variant={form.timerMinutes === minutes ? "default" : "secondary"}
                    onClick={() => update({ timerMinutes: minutes })}
                  >
                    {formatDuration(minutes)}
                  </Button>
                ))}
              </div>
              <DurationField
                minutes={form.timerMinutes}
                maxMinutes={MAX_TIMER_MINUTES}
                onChange={(timerMinutes) => update({ timerMinutes })}
              />
            </div>
          )}

          {form.kind === "sun" && (
            <div className="space-y-3 pt-1">
              <Segmented
                options={[
                  { value: "sunrise", label: t("schedule.sun.sunrise") },
                  { value: "sunset", label: t("schedule.sun.sunset") },
                ]}
                value={form.sunEvent}
                onChange={(sunEvent) => update({ sunEvent })}
              />
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  {form.sunEvent === "sunrise" ? <Sunrise className="size-4 text-amber-500" /> : <Moon className="size-4 text-indigo-400" />}
                  <Slider
                    min={-SUN_LEAD}
                    max={SUN_LEAD}
                    step={5}
                    value={[form.offset]}
                    onValueChange={([offset]) => update({ offset: offset! })}
                    aria-label={t("schedule.editor.offset")}
                  />
                </div>
                <p className="flex justify-between text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{describeSun({ kind: "sun", event: form.sunEvent, offsetMinutes: form.offset, days: form.sunDays })}</span>
                  {sunNext && <span>{t("schedule.editor.next", { when: formatWhen(sunNext, now, timeZone) })}</span>}
                </p>
              </div>
              <DayChips days={form.sunDays} allowOnce={false} onChange={(sunDays) => update({ sunDays })} />
              <p className="text-[11px] text-muted-foreground">{t("schedule.editor.sun_place", { place: location.name })}</p>
            </div>
          )}
        </Field>

        {form.kind !== "timer" && (
          <Field label={t("schedule.editor.action")}>
            <Segmented
              options={[
                { value: "on", label: t("schedule.action.on") },
                { value: "off", label: t("schedule.action.off") },
              ]}
              value={form.on ? "on" : "off"}
              onChange={(v) => update({ on: v === "on" })}
            />
            {form.on && (
              <div className="flex items-center gap-3 pt-1">
                <Switch
                  checked={form.setBrightness}
                  onCheckedChange={(setBrightness) => update({ setBrightness })}
                  aria-label={t("schedule.editor.brightness")}
                />
                <Slider
                  min={1}
                  max={100}
                  disabled={!form.setBrightness}
                  value={[form.brightness]}
                  onValueChange={([brightness]) => update({ brightness: brightness! })}
                  aria-label={t("schedule.editor.brightness")}
                />
                <span className={cn("w-10 shrink-0 text-right text-xs tabular-nums", !form.setBrightness && "text-muted-foreground")}>
                  {form.setBrightness ? `${form.brightness}%` : t("schedule.editor.last")}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 pt-1 text-xs">
              <span>{t("schedule.editor.fade")}</span>
              <Select value={String(form.fade)} onValueChange={(fade) => update({ fade: Number(fade) })}>
                <SelectTrigger size="sm" className="w-32 text-xs" aria-label={t("schedule.editor.fade")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FADES.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)} className="text-xs">
                      {minutes === 0 ? t("schedule.editor.fade_none") : formatDuration(minutes)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>
        )}

        {error && (
          <p role="alert" data-selectable className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="justify-between">
          {request.existing ? (
            <Button variant="ghost" size="sm" className="text-destructive" disabled={saving} onClick={() => void remove()}>
              {t("schedule.editor.delete")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={closeScheduleEditor}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={saving || !room} onClick={() => void save()}>
              {t("schedule.editor.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
