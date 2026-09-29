// What's coming for a room, on its card: a running timer as a bar with a
// live countdown (+15 min, cancel), otherwise the next schedule in one line.

import { CalendarClock, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { log } from "@/core/log";
import { automationsOf, bridgeNow, nextRunOf, schedules, useSchedules } from "@/core/schedules";
import { t } from "@/i18n";
import { formatCountdown, formatWhen } from "@/lib/time";
import type { RoomView } from "@/types";
import { describeAction, useNow } from "./describe";

export function RoomScheduleStatus({ room }: { room: RoomView }) {
  const { timeZone } = useSchedules();
  useNow(1_000);
  if (!room.v1GroupId) return null;

  const now = bridgeNow();
  const upcoming = automationsOf(room)
    .map((automation) => ({ automation, at: nextRunOf(automation, now) }))
    .filter((x): x is { automation: typeof x.automation; at: number } => x.at !== null && x.at > now)
    .sort((a, b) => a.at - b.at);

  const timer = upcoming.find((x) => x.automation.trigger.kind === "timer");
  if (timer) {
    const fail = (error: unknown) => log.warn("ui", "schedule.timer_failed", String(error));
    return (
      <div className="mt-3 flex items-center gap-2 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs">
        <Timer className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate" aria-live="off">
          {t("schedule.timer_status", {
            action: describeAction(timer.automation.action),
            time: formatCountdown(timer.at - now),
          })}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void schedules.extendTimer(timer.automation, 15).catch(fail)}
        >
          {t("schedule.extend")}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("schedule.cancel_timer")}
          title={t("schedule.cancel_timer")}
          onClick={() => void schedules.remove(timer.automation).catch(fail)}
        >
          <X />
        </Button>
      </div>
    );
  }

  const next = upcoming[0];
  if (!next) return null;
  return (
    <p className="mt-2 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
      <CalendarClock className="size-3 shrink-0" aria-hidden />
      {t("schedule.next", {
        action: describeAction(next.automation.action),
        when: formatWhen(next.at, now, timeZone),
      })}
    </p>
  );
}
