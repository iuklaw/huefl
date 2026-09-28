import { House } from "lucide-react";
import { AmbientGradient } from "@/components/AmbientGradient";
import { RoomCard } from "@/components/RoomCard";
import { StatusBanner } from "@/components/StatusBanner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { actions } from "@/core/app";
import { t } from "@/i18n";
import type { AppState } from "@/types";

type Props = {
  state: AppState;
  /** Expanded rooms, lights and `presets:<roomId>` — owned by App so they survive visiting Options. */
  expanded: ReadonlySet<string>;
  onExpandedChange: (expanded: ReadonlySet<string>) => void;
  onOpenBridgeSettings: () => void;
};

export function HomeView({ state, expanded, onExpandedChange, onOpenBridgeSettings }: Props) {
  const toggleExpanded = (id: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    onExpandedChange(next);
  };

  const hasRooms = state.rooms.length > 0;
  const syncingRooms = new Set(state.syncing.rooms);
  const syncingLights = new Set(state.syncing.lights);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <AmbientGradient rooms={state.rooms} />
      <ScrollArea className="relative z-10 min-h-0 flex-1">
        {/* Bottom padding lets the last card scroll above the strongest glow. */}
        <div className="space-y-3 p-3 pb-[12vh]">
          <StatusBanner state={state} onOpenBridgeSettings={onOpenBridgeSettings} />

          {hasRooms && (
            <div className="flex items-center justify-between px-1 pt-1">
              <h1 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("home.rooms")}
              </h1>
              <div className="flex gap-1">
                <Button size="xs" variant="ghost" onClick={() => actions.setAllRooms(true)}>
                  {t("home.all_on")}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => actions.setAllRooms(false)}>
                  {t("home.all_off")}
                </Button>
              </div>
            </div>
          )}

          {state.rooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              lights={state.lights.filter((l) => l.roomId === room.id)}
              expanded={expanded.has(room.id)}
              onExpandedChange={(open) => toggleExpanded(room.id, open)}
              syncing={{ room: syncingRooms.has(room.id), lights: syncingLights }}
              expandedLights={expanded}
              onLightExpandedChange={toggleExpanded}
              scenes={state.library.scenes.filter((scene) => scene.roomId === room.id)}
              presetsExpanded={expanded.has(`presets:${room.id}`)}
              onPresetsExpandedChange={(open) => toggleExpanded(`presets:${room.id}`, open)}
            />
          ))}

          {!hasRooms && state.status === "connecting" && (
            <div className="flex justify-center py-16 text-muted-foreground">
              <Spinner className="size-6" />
            </div>
          )}

          {!hasRooms && state.status === "ready" && (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
              <House className="size-10 text-muted-foreground" aria-hidden />
              <p className="font-semibold">{t("rooms.empty_title")}</p>
              <p className="text-sm text-muted-foreground">{t("rooms.empty_text")}</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
