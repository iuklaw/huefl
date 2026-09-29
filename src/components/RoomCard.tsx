import { useMemo, useState, type ReactNode } from "react";
import { BookmarkPlus, ChevronRight, Lightbulb, Sun } from "lucide-react";
import { LevelSlider } from "@/components/LevelSlider";
import { LightRow } from "@/components/LightRow";
import { RoomPresets } from "@/components/RoomPresets";
import { RoomScheduleMenu } from "@/components/schedule/RoomScheduleMenu";
import { RoomScheduleStatus } from "@/components/schedule/RoomScheduleStatus";
import { SavePresetDialog } from "@/components/SavePresetDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { actions } from "@/core/app";
import { sync } from "@/core/sync";
import { log } from "@/core/log";
import { t, tPlural, type MessageKey } from "@/i18n";
import { accentStyles, toCss } from "@/lib/color";
import { POPULAR_PALETTES } from "@/lib/palettes";
import { findActivePreset } from "@/lib/presets";
import { cn } from "@/lib/utils";
import type { LightView, RoomView, Scene } from "@/types";

type Props = {
  room: RoomView;
  lights: LightView[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Room ids / light ids with commands not yet confirmed by the bridge. */
  syncing: { room: boolean; lights: ReadonlySet<string> };
  expandedLights: ReadonlySet<string>;
  onLightExpandedChange: (lightId: string, expanded: boolean) => void;
  /** Saved scenes of this room, newest first. */
  scenes: Scene[];
  presetsExpanded: boolean;
  /** Some of the room's lights are streaming (sync) — the bridge ignores
   *  regular commands to them, so the controls pause instead of pretending. */
  syncLocked: boolean;
  onPresetsExpandedChange: (expanded: boolean) => void;
  onOpenSchedules: () => void;
};

export function RoomCard({
  room,
  lights,
  expanded,
  onExpandedChange,
  syncing,
  expandedLights,
  onLightExpandedChange,
  scenes,
  presetsExpanded,
  onPresetsExpandedChange,
  syncLocked,
  onOpenSchedules,
}: Props) {
  const [saving, setSaving] = useState(false);
  const tint = room.on && room.color ? room.color : null;
  // Derived from what the lights show — see findActivePreset in lib/presets.ts.
  const active = useMemo(
    () => findActivePreset(lights, scenes, POPULAR_PALETTES),
    [lights, scenes],
  );
  const activeName = !active
    ? null
    : active.kind === "scene"
      ? (scenes.find((s) => s.id === active.id)?.name ?? null)
      : t(`palette.${active.id}` as MessageKey);
  const accent = accentStyles(room.color);
  const summary =
    tPlural("room.lights", room.lightIds.length) +
    (room.on
      ? t("room.brightness_suffix", { brightness: room.brightness })
      : ` · ${t("room.off")}`);

  return (
    <section className="rounded-lg bg-card p-3 text-card-foreground">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full ring-1 ring-border transition-colors",
            !tint && (room.on ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"),
          )}
          // The room's average light color (see roomColor in hue/model.ts).
          style={tint ? { backgroundColor: toCss(tint, 0.2), color: toCss(tint) } : undefined}
          aria-hidden
        >
          <Lightbulb className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-baseline gap-1.5 text-sm font-semibold">
            <span className="shrink-0 truncate">{room.name}</span>
            {activeName && (
              // The room name keeps its space; a long preset name gets cut.
              <span
                className="min-w-0 truncate text-xs font-medium"
                style={{ color: accent.text }}
                title={activeName}
                aria-label={t("presets.current_label", { name: activeName })}
              >
                <span className="text-muted-foreground" aria-hidden>
                  ·{" "}
                </span>
                {activeName}
              </span>
            )}
          </h2>
          <p
            aria-live="polite"
            className="flex items-center gap-1.5 truncate text-xs text-muted-foreground"
          >
            {syncing.room ? (
              <>
                <Spinner className="size-3" />
                {t("room.syncing")}
              </>
            ) : (
              summary
            )}
          </p>
        </div>
        <RoomScheduleMenu room={room} disabled={syncLocked} onOpenSchedules={onOpenSchedules} />
        <Switch
          checked={room.on}
          disabled={syncLocked}
          onCheckedChange={(on) => void actions.setRoom({ id: room.id, on })}
          aria-label={t("room.toggle_label", { name: room.name })}
        />
      </div>

      {!syncLocked && <RoomScheduleStatus room={room} />}

      {syncLocked && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("sync.room_locked")}</span>
          <Button size="xs" variant="ghost" onClick={() => void sync.stop()}>
            {t("sync.stop")}
          </Button>
        </div>
      )}

      <div inert={syncLocked} className={cn("transition-opacity", syncLocked && "opacity-50")}>
        <LevelSlider
          className="mt-3"
          icon={<Sun />}
          label={t("room.brightness_label", { name: room.name })}
          value={Math.max(1, room.brightness)}
          onChange={(brightness) => void actions.setRoom({ id: room.id, brightness, on: true })}
          onCommit={(brightness) =>
            log.info("command", "command.user", `${room.name}: brightness ${brightness}%`, {
              origin: "ui",
              room: { id: room.id, name: room.name },
              brightness,
            })
          }
        />

        {lights.length > 0 && (
          <Collapsible open={expanded} onOpenChange={onExpandedChange} className="mt-2">
            <SectionTrigger open={expanded} count={lights.length}>
              {t("room.lights_toggle")}
            </SectionTrigger>
            <CollapsibleContent className="overflow-hidden data-open:animate-collapsible-down data-closed:animate-collapsible-up">
              <div className="mt-1 space-y-0.5">
                {lights.map((light) => (
                  <LightRow
                    key={light.id}
                    light={light}
                    syncing={syncing.lights.has(light.id)}
                    expanded={expandedLights.has(light.id)}
                    onExpandedChange={(open) => onLightExpandedChange(light.id, open)}
                  />
                ))}
              </div>
              <Button
                size="xs"
                variant="ghost"
                className="mt-1 text-muted-foreground"
                onClick={() => setSaving(true)}
              >
                <BookmarkPlus />
                {t("presets.save")}
              </Button>
            </CollapsibleContent>
          </Collapsible>
        )}

        <Collapsible open={presetsExpanded} onOpenChange={onPresetsExpandedChange} className="mt-1">
          <SectionTrigger open={presetsExpanded} count={scenes.length || undefined}>
            {t("presets.title")}
          </SectionTrigger>
          <CollapsibleContent className="overflow-hidden data-open:animate-collapsible-down data-closed:animate-collapsible-up">
            <RoomPresets room={room} scenes={scenes} active={active} accent={accent} />
          </CollapsibleContent>
        </Collapsible>

        <SavePresetDialog
          open={saving}
          onOpenChange={setSaving}
          room={room}
          lights={lights}
          scenes={scenes}
          onSaved={() => onPresetsExpandedChange(true)}
        />
      </div>
    </section>
  );
}

/** Discord-style category header: chevron, uppercase label, optional count. */
function SectionTrigger({
  open,
  count,
  children,
}: {
  open: boolean;
  count?: number;
  children: ReactNode;
}) {
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-1 rounded-sm py-1 text-[11px] font-semibold uppercase tracking-wide",
        "text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground",
      )}
    >
      <ChevronRight
        className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")}
        aria-hidden
      />
      {children}
      {count !== undefined && (
        <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] leading-4">{count}</span>
      )}
    </CollapsibleTrigger>
  );
}
