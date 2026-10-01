// All light schedules: the sky over the chosen place, where that is, and the
// schedules room by room. They run on the bridge - this only shows and edits
// them (core/schedules.ts).

import { useEffect, useState } from "react";
import { ArrowLeft, CalendarClock, MapPin, Plus, RefreshCw, Sunset, Timer } from "lucide-react";
import { LocationDialog } from "@/components/schedule/LocationDialog";
import { SunArc } from "@/components/schedule/SunArc";
import { describeAction, describeTrigger, useNow } from "@/components/schedule/describe";
import { openScheduleEditor } from "@/components/schedule/editor-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { log } from "@/core/log";
import { nextRunOf, scheduleLocation, schedules, useSchedules } from "@/core/schedules";
import { useAppState } from "@/core/useAppState";
import type { Automation } from "@/hue/schedules";
import { t } from "@/i18n";
import { formatCountdown, formatWhen } from "@/lib/time";

/** The bridge's limits (API v1). */
const MAX_SCHEDULES = 100;
const MAX_RULES = 250;

export function SchedulesView({ onBack }: { onBack: () => void }) {
  const { rooms } = useAppState();
  const { automations, loading, loaded, error, timeZone, clockOffset } = useSchedules();
  const [locationOpen, setLocationOpen] = useState(false);
  const now = useNow(1_000) + clockOffset;

  useEffect(() => {
    void schedules.refresh();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[role=dialog],[role=alertdialog]")) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const location = scheduleLocation();
  const byRoom = rooms
    .map((room) => ({ room, items: automations.filter((a) => a.groupId === room.v1GroupId) }))
    .filter((group) => group.items.length > 0);
  const counts = {
    schedules: automations.filter((a) => a.source === "schedule").length,
    rules: automations.filter((a) => a.source === "rule").length,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label={t("options.back")}>
          <ArrowLeft />
        </Button>
        <h1 className="flex-1 text-sm font-semibold">{t("schedule.title")}</h1>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void schedules.refresh()}
          aria-label={t("schedule.refresh")}
          title={t("schedule.refresh")}
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
        <Button size="sm" onClick={() => openScheduleEditor({ kind: "time" })}>
          <Plus />
          {t("schedule.new")}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3 pb-10">
          <SunArc />

          <button
            type="button"
            onClick={() => setLocationOpen(true)}
            className="flex w-full items-center gap-2 rounded-md px-1 text-left text-xs hover:text-foreground"
          >
            <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{location.name}</span>
              <span className="text-muted-foreground"> · {location.timeZone}</span>
            </span>
            <span className="shrink-0 text-primary">{t("schedule.location.change")}</span>
          </button>

          {error && (
            <p role="alert" data-selectable className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              {t("schedule.load_failed")} {error}
            </p>
          )}

          {loaded && byRoom.length === 0 && (
            <div className="space-y-2 py-8 text-center">
              <CalendarClock className="mx-auto size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("schedule.empty")}</p>
              <p className="text-xs text-muted-foreground">{t("schedule.empty_hint")}</p>
            </div>
          )}

          {byRoom.map(({ room, items }) => (
            <section key={room.id} className="space-y-1.5">
              <h2 className="px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{room.name}</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-lg bg-card">
                {items.map((automation) => (
                  <ScheduleRow key={`${automation.source}:${automation.id}`} automation={automation} now={now} timeZone={timeZone} />
                ))}
              </ul>
            </section>
          ))}

        </div>
      </ScrollArea>

      {/* Pinned to the bottom; pb-7 clears the app footer, which overlays the window's bottom. */}
      {loaded && (
        <p className="shrink-0 border-t border-border bg-background/70 px-3 pt-1.5 pb-7 text-[11px] text-muted-foreground backdrop-blur-sm">
          {t("schedule.on_bridge", {
            schedules: `${counts.schedules} / ${MAX_SCHEDULES}`,
            rules: `${counts.rules} / ${MAX_RULES}`,
          })}
        </p>
      )}

      <LocationDialog open={locationOpen} onOpenChange={setLocationOpen} />
    </div>
  );
}

function ScheduleRow({ automation, now, timeZone }: { automation: Automation; now: number; timeZone: string }) {
  const Icon = automation.trigger.kind === "timer" ? Timer : automation.trigger.kind === "sun" ? Sunset : CalendarClock;
  const next = nextRunOf(automation, now);
  const isTimer = automation.trigger.kind === "timer";
  const fail = (error: unknown) => log.warn("ui", "schedule.change_failed", String(error));

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => openScheduleEditor({ existing: automation })}
        title={t("schedule.edit")}
      >
        <p className="truncate text-xs font-medium">{describeTrigger(automation.trigger)}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {describeAction(automation.action)}
          {next !== null &&
            (isTimer
              ? ` · ${formatCountdown(next - now)}`
              : ` · ${t("schedule.next_short", { when: formatWhen(next, now, timeZone) })}`)}
        </p>
      </button>
      {isTimer ? (
        <Button size="xs" variant="ghost" onClick={() => void schedules.remove(automation).catch(fail)}>
          {t("schedule.cancel_timer")}
        </Button>
      ) : (
        <Switch
          checked={automation.enabled}
          onCheckedChange={(enabled) => void schedules.setEnabled(automation, enabled).catch(fail)}
          aria-label={t("schedule.enabled_label")}
        />
      )}
    </li>
  );
}
