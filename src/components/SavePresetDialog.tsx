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
import { actions } from "@/core/app";
import { t } from "@/i18n";
import { toCss } from "@/lib/color";
import type { LightView, RoomView, Scene } from "@/types";

const MAX_NAME_LENGTH = 40;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomView;
  lights: LightView[];
  /** This room's saved scenes — to suggest a free default name. */
  scenes: Scene[];
  onSaved: () => void;
};

/** Names the current look of a room and saves it as a scene. */
export function SavePresetDialog({ open, onOpenChange, room, lights, scenes, onSaved }: Props) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(defaultName(scenes));
    // Select the suggestion so typing replaces it.
    requestAnimationFrame(() => input.current?.select());
  }, [open, scenes]);

  const trimmed = name.trim();
  const preview = lights.filter((l) => l.on && l.color);

  const save = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    await actions.saveScene(room.id, trimmed);
    setSaving(false);
    onOpenChange(false);
    onSaved();
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
            <DialogTitle>{t("presets.save_title")}</DialogTitle>
            <DialogDescription>
              {t("presets.save_description", { room: room.name })}
            </DialogDescription>
          </DialogHeader>

          {preview.length > 0 && (
            <div className="flex gap-1.5" aria-hidden>
              {preview.map((light) => (
                <span
                  key={light.id}
                  title={light.name}
                  className="size-5 rounded-full ring-1 ring-border"
                  style={{ backgroundColor: toCss(light.color!) }}
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
