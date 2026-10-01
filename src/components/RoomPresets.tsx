// The "Color presets" section of a room: the user's saved scenes for this room,
// and ready-made popular palettes. One click applies either.

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
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
import type { LightView, RoomView, Scene } from "@/types";

type Props = {
  room: RoomView;
  /** The room's lights — editing a preset can take their current look. */
  lights: LightView[];
  scenes: Scene[];
  /** The preset the lights currently show (see findActivePreset). */
  active: ActivePreset | null;
  /** Room-color accent for the current preset — kept faint on purpose. */
  accent: { text: string; border: string };
};

export function RoomPresets({ room, lights, scenes, active, accent }: Props) {
  const [toEdit, setToEdit] = useState<Scene | null>(null);
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
            {scenes.map((scene) => {
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
      </section>

      <section className="space-y-1.5">
        <SubHeading>{t("presets.popular")}</SubHeading>
        <div className="grid grid-cols-2 gap-1.5">
          {POPULAR_PALETTES.map((palette) => {
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

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}
