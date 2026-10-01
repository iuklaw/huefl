import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { actions } from "@/core/app";
import { t } from "@/i18n";
import { toCss } from "@/lib/color";
import { scenePreview } from "@/lib/presets";
import type { LightView, RoomView, Scene } from "@/types";

const MAX_NAME_LENGTH = 40;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomView;
  lights: LightView[];
  /** This room's saved scenes — to suggest a free default name. */
  scenes: Scene[];
  /** Edit this scene (rename, optionally take the current look) instead of saving a new one. */
  scene?: Scene;
  onSaved?: () => void;
};

/** Names the current look of a room and saves it as a scene — or edits a saved one. */
export function SavePresetDialog({ open, onOpenChange, room, lights, scenes, scene, onSaved }: Props) {
  const [name, setName] = useState("");
  const [recapture, setRecapture] = useState(false);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const editing = scene !== undefined;

  useEffect(() => {
    if (!open) return;
    setName(scene?.name ?? defaultName(scenes));
    setRecapture(false);
    // Select the name so typing replaces it.
    requestAnimationFrame(() => input.current?.select());
  }, [open, scenes, scene]);

  const trimmed = name.trim();
  // What the preset will hold: the lights now, or (editing) what it has.
  const current = lights.filter((l) => l.on && l.color).map((l) => ({ key: l.id, title: l.name, color: l.color! }));
  const preview =
    editing && !recapture
      ? scenePreview(scene, 12).map((color, i) => ({ key: String(i), title: undefined, color }))
      : current;

  const save = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    if (scene) await actions.updateScene(scene.id, { name: trimmed, recapture });
    else await actions.saveScene(room.id, trimmed);
    setSaving(false);
    onOpenChange(false);
    onSaved?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(editing ? "presets.edit_title" : "presets.save_title")}</DialogTitle>
            <DialogDescription>
              {editing
                ? t("presets.edit_description", { room: room.name })
                : t("presets.save_description", { room: room.name })}
            </DialogDescription>
          </DialogHeader>

          {preview.length > 0 && (
            <div className="flex gap-1.5" aria-hidden>
              {preview.map((item) => (
                <span
                  key={item.key}
                  title={item.title}
                  className="size-5 rounded-full ring-1 ring-border"
                  style={{ backgroundColor: toCss(item.color) }}
                />
              ))}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="preset-name">{t("presets.name_label")}</Label>
            <Input
              id="preset-name"
              ref={input}
              value={name}
              maxLength={MAX_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {editing && (
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                {t("presets.recapture")}
                <span className="block text-xs text-muted-foreground">{t("presets.recapture_hint")}</span>
              </span>
              <Switch checked={recapture} onCheckedChange={setRecapture} />
            </label>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!trimmed || saving}>
              {t("presets.save_confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Preset N" with the first N not taken in this room. */
function defaultName(scenes: Scene[]): string {
  const taken = new Set(scenes.map((s) => s.name));
  let n = scenes.length + 1;
  while (taken.has(t("presets.default_name", { n }))) n++;
  return t("presets.default_name", { n });
}
