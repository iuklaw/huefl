// The clock button on a room card: quick timers (a typed-in number of
// minutes) that fit the room's state - "off in" / "off for" while it's on,
// "on for" / "on in" while it's off - a custom timer, a new schedule, the list.

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
import { automationsOf, schedules, useSchedules, type TimerMode } from "@/core/schedules";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import type { RoomView } from "@/types";
import { clampMinutes, MAX_TIMER_MINUTES } from "./describe";
import { openScheduleEditor } from "./editor-store";

const LABELS: Record<TimerMode, MessageKey> = {
  off_in: "schedule.editor.timer_off",
  off_for: "schedule.editor.timer_off_for",
  on_in: "schedule.editor.timer_on_in",
  on_for: "schedule.editor.timer_on",
};

type Props = { room: RoomView; disabled?: boolean; onOpenSchedules: () => void };

export function RoomScheduleMenu({ room, disabled, onOpenSchedules }: Props) {
  useSchedules(); // re-render when schedules change
  const [open, setOpen] = useState(false);
  if (!room.v1GroupId) return null;
  const active = automationsOf(room).some((a) => a.enabled);
  const modes: TimerMode[] = room.on ? ["off_in", "off_for"] : ["on_for", "on_in"];

  const start = (mode: TimerMode, minutes: number) => {
    setOpen(false);
    void schedules
      .startTimer(room, minutes, mode)
      .catch((error) => log.warn("ui", "schedule.timer_failed", String(error)));
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
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{room.name}</DropdownMenuLabel>
        {modes.map((mode) => (
          <QuickTimer
            key={mode}
            label={t(LABELS[mode])}
            onStart={(minutes) => start(mode, minutes)}
            onClose={() => setOpen(false)}
          />
        ))}

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

/**
 * "Turn off in [45] min ▶". Not a menu item: keys typed here must not drive
 * the menu's type-ahead or arrow navigation; Enter starts, Esc closes.
 */
function QuickTimer({
  label,
  onStart,
  onClose,
}: {
  label: string;
  onStart: (minutes: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("45");
  const start = () => Number(value) > 0 && onStart(clampMinutes(Number(value)));

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 text-xs"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") start();
        if (event.key === "Escape") onClose();
      }}
    >
      <Timer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {/* Fixed width, so both rows' inputs line up. */}
      <span className="w-19 shrink-0">{label}</span>
      <input
        type="number"
        min={1}
        max={MAX_TIMER_MINUTES}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.target.select()}
        aria-label={`${label} (${t("schedule.custom_minutes")})`}
        className="h-6 w-12 min-w-0 rounded-md border border-input bg-transparent px-1 text-center tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="text-muted-foreground">{t("schedule.minutes_unit")}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        className="ml-auto"
        aria-label={`${label} - ${t("schedule.start")}`}
        title={t("schedule.start")}
        disabled={!(Number(value) > 0)}
        onClick={start}
      >
        <Play />
      </Button>
    </div>
  );
}
