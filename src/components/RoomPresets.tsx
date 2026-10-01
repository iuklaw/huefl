// The "Color presets" section of a room: the user's saved scenes for this room,
// the color of the day, and ready-made popular palettes. One click applies any.
// Long lists show three rows and the rest under "Show more".

import { useState } from "react";
import { CloudOff, Pencil, Trash2 } from "lucide-react";
import { SavePresetDialog } from "@/components/SavePresetDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { actions } from "@/core/app";
import { t, type MessageKey } from "@/i18n";
import { toCss } from "@/lib/color";
import { POPULAR_PALETTES } from "@/lib/palettes";
import { paletteBackground, scenePreview, type ActivePreset } from "@/lib/presets";
import { cn } from "@/lib/utils";
import type { DailyState } from "@/core/daily";
import type { LightView, Palette, RoomView, Scene } from "@/types";

type Props = {
  room: RoomView;
  /** The room's lights - editing a preset can take their current look. */
  lights: LightView[];
  scenes: Scene[];
  /** The preset the lights currently show (see findActivePreset). */
  active: ActivePreset | null;
  /** Room-color accent for the current preset - kept faint on purpose. */
  accent: { text: string; border: string };
  /** The color of the day, and the palette made from it for this room. */
  daily: { state: DailyState; palette: Palette | null };
};

/** Saved: three presets; Popular: three rows of two. */
const SAVED_ROWS = 3;
const POPULAR_ROWS = 3;

/**
 * The first `limit` items, or all when expanded. The current one stays in
 * view even when it's among the hidden - you should see what's on.
 */
function visible<T>(items: T[], limit: number, expanded: boolean, isCurrent: (item: T) => boolean): T[] {
  if (expanded || items.length <= limit) return items;
  const shown = items.slice(0, limit);
  const current = items.slice(limit).find(isCurrent);
  return current ? [...shown, current] : shown;
}

export function RoomPresets({ room, lights, scenes, active, accent, daily }: Props) {
  const [toEdit, setToEdit] = useState<Scene | null>(null);
  const [allSaved, setAllSaved] = useState(false);
  const [allPopular, setAllPopular] = useState(false);
  const isActive = (kind: ActivePreset["kind"], id: string) =>
    active?.kind === kind && active.id === id;
  const [toDelete, setToDelete] = useState<Scene | null>(null);

  return (
    <div className="space-y-3 pt-1">
      <section className="space-y-1">
        <SubHeading>{t("presets.saved")}</SubHeading>
        {scenes.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">{t("presets.empty")}</p>
        ) : (
          <ul className="space-y-0.5">
            {visible(scenes, SAVED_ROWS, allSaved, (s) => isActive("scene", s.id)).map((scene) => {
              const current = isActive("scene", scene.id);
              return (
                <li
                  key={scene.id}
                  // Always bordered (transparent) so marking one never shifts the layout.
                  className="group flex items-center rounded-md border border-transparent hover:bg-accent/60"
                  style={current ? { borderColor: accent.border } : undefined}
                  aria-current={current || undefined}
                >
                  <button
                    type="button"
                    onClick={() => actions.applyScene(scene)}
                    aria-label={t("presets.apply_label", { name: scene.name })}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex shrink-0 -space-x-1" aria-hidden>
                      {scenePreview(scene).map((color, index) => (
                        <span
                          key={index}
                          className="size-3.5 rounded-full ring-2 ring-card"
                          style={{ backgroundColor: toCss(color) }}
                        />
                      ))}
                    </span>
                    <span
                      className="truncate text-sm"
                      style={current ? { color: accent.text } : undefined}
                    >
                      {scene.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setToEdit(scene)}
                    aria-label={t("presets.edit_label", { name: scene.name })}
                    className={cn(
                      "rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity outline-none",
                      "group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setToDelete(scene)}
                    aria-label={t("presets.delete_label", { name: scene.name })}
                    className={cn(
                      "mr-1 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity outline-none",
                      "group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <ShowMore total={scenes.length} limit={SAVED_ROWS} expanded={allSaved} onToggle={() => setAllSaved(!allSaved)} />
      </section>

      <DailyTile room={room} daily={daily} current={isActive("palette", "daily")} accent={accent} />

      <section className="space-y-1.5">
        <SubHeading>{t("presets.popular")}</SubHeading>
        <div className="grid grid-cols-2 gap-1.5">
          {visible(POPULAR_PALETTES, POPULAR_ROWS * 2, allPopular, (p) => isActive("palette", p.id)).map((palette) => {
            const name = t(`palette.${palette.id}` as MessageKey);
            const current = isActive("palette", palette.id);
            return (
              <button
                key={palette.id}
                type="button"
                onClick={() => actions.applyPalette(room.id, palette)}
                aria-label={t("presets.apply_label", { name })}
                aria-current={current || undefined}
                className="overflow-hidden rounded-md border border-transparent bg-muted/60 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                style={current ? { borderColor: accent.border } : undefined}
              >
                <span
                  className="block h-5"
                  style={{ background: paletteBackground(palette) }}
                  aria-hidden
                />
                <span
                  className="block px-2 py-1 text-xs"
                  style={current ? { color: accent.text } : undefined}
                >
                  {name}
                </span>
              </button>
            );
          })}
        </div>
        <ShowMore
          total={POPULAR_PALETTES.length}
          limit={POPULAR_ROWS * 2}
          expanded={allPopular}
          onToggle={() => setAllPopular(!allPopular)}
        />
      </section>

      <SavePresetDialog
        open={toEdit !== null}
        onOpenChange={(open) => !open && setToEdit(null)}
        room={room}
        lights={lights}
        scenes={scenes}
        scene={toEdit ?? undefined}
      />

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("presets.delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("presets.delete_description", { name: toDelete?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => toDelete && void actions.deleteScene(toDelete.id)}
            >
              {t("presets.delete_confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ShowMore({
  total,
  limit,
  expanded,
  onToggle,
}: {
  total: number;
  limit: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (total <= limit) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {expanded ? t("presets.show_less") : t("presets.show_more", { count: total - limit })}
    </button>
  );
}

/** "Color of the day": its palette for this room; greyed out when offline. */
function DailyTile({
  room,
  daily,
  current,
  accent,
}: {
  room: RoomView;
  daily: Props["daily"];
  current: boolean;
  accent: Props["accent"];
}) {
  const { state, palette } = daily;
  const name = t("palette.daily");
  return (
    <section className="space-y-1.5">
      <SubHeading>{t("presets.daily")}</SubHeading>
      {state.status === "loading" ? (
        <div className="h-[2.85rem] animate-pulse rounded-md bg-muted/60" aria-hidden />
      ) : state.status === "offline" || !palette ? (
        <div
          className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-2 text-xs text-muted-foreground"
          title={t("presets.daily_offline_hint")}
        >
          <CloudOff className="size-3.5 shrink-0" aria-hidden />
          {t("presets.daily_offline")}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => actions.applyPalette(room.id, palette)}
          aria-label={t("presets.apply_label", { name })}
          aria-current={current || undefined}
          className="w-full overflow-hidden rounded-md border border-transparent bg-muted/60 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          style={current ? { borderColor: accent.border } : undefined}
        >
          <span className="block h-5" style={{ background: paletteBackground(palette) }} aria-hidden />
          <span className="flex justify-between px-2 py-1 text-xs" style={current ? { color: accent.text } : undefined}>
            {name}
            <span className="font-mono text-muted-foreground uppercase">{state.hex}</span>
          </span>
        </button>
      )}
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}
