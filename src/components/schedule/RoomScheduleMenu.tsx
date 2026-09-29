// The clock button on a room card: quick timers (presets or a typed-in number
// of minutes), a new schedule, the list.

import { useState } from "react";
import { AlarmClock, CalendarClock, ListChecks, Play, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { log } from "@/core/log";
import { automationsOf, schedules, useSchedules } from "@/core/schedules";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { RoomView } from "@/types";
import { clampMinutes, formatDuration, MAX_TIMER_MINUTES } from "./describe";
import { openScheduleEditor } from "./editor-store";

const OFF_IN = [15, 30, 60];
const ON_FOR = [20, 60];

type Props = { room: RoomView; disabled?: boolean; onOpenSchedules: () => void };

export function RoomScheduleMenu({ room, disabled, onOpenSchedules }: Props) {
  useSchedules(); // re-render when schedules change
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("45");
  if (!room.v1GroupId) return null;
  const active = automationsOf(room).some((a) => a.enabled);

  const timer = (minutes: number, on: boolean) =>
    void schedules.startTimer(room, minutes, on).catch((error) =>
      log.warn("ui", "schedule.timer_failed", String(error)),
    );
  const startCustom = () => {
    const minutes = clampMinutes(Number(custom));
    setOpen(false);
    timer(minutes, !room.on);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={disabled}
          aria-label={t("schedule.menu_label", { name: room.name })}
          title={t("schedule.menu_label", { name: room.name })}
          className={cn(active && "text-primary")}
        >
          <AlarmClock />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{room.name}</DropdownMenuLabel>
        {(room.on ? OFF_IN : ON_FOR).map((minutes) => (
          <DropdownMenuItem key={minutes} className="text-xs" onSelect={() => timer(minutes, !room.on)}>
            <Timer />
            {t(room.on ? "schedule.off_in" : "schedule.on_for", { duration: formatDuration(minutes) })}
          </DropdownMenuItem>
        ))}

        {/* Any number of minutes. Not a menu item: keys typed here must not
            drive the menu's type-ahead or arrow navigation. */}
        <div
          className="flex items-center gap-1.5 px-2 py-1 text-xs"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") startCustom();
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <Timer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0">{t(room.on ? "schedule.editor.timer_off" : "schedule.editor.timer_on")}</span>
          <input
            type="number"
            min={1}
            max={MAX_TIMER_MINUTES}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onFocus={(event) => event.target.select()}
            aria-label={t("schedule.custom_minutes")}
            className="h-6 w-12 min-w-0 rounded-md border border-input bg-transparent px-1 text-center tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="text-muted-foreground">{t("schedule.minutes_unit")}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            className="ml-auto"
            aria-label={t("schedule.start")}
            title={t("schedule.start")}
            disabled={!Number(custom)}
            onClick={startCustom}
          >
            <Play />
          </Button>
        </div>

        <DropdownMenuItem
          className="text-xs"
          onSelect={() => openScheduleEditor({ roomId: room.id, kind: "timer" })}
        >
          <Timer />
          {t("schedule.custom_timer")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-xs" onSelect={() => openScheduleEditor({ roomId: room.id, kind: "time" })}>
          <CalendarClock />
          {t("schedule.add")}
        </DropdownMenuItem>
        <DropdownMenuItem className="text-xs" onSelect={onOpenSchedules}>
          <ListChecks />
          {t("schedule.all")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
