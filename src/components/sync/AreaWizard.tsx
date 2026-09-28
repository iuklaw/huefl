// Create or edit a sync area (an Entertainment configuration on the bridge):
//   1. what it is for (music / TV / desk monitor)
//   2. which lights — only those that can stream; the rest are shown with why not
//   3. where they are (screen areas only): drag the lights on a top view
// Areas made here and in the Philips Hue app are the same bridge resources.

import { useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Music, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Spinner } from "@/components/ui/spinner";
import { useAppState } from "@/core/useAppState";
import { sync } from "@/core/sync";
import { t, type MessageKey } from "@/i18n";
import { toCss } from "@/lib/color";
import { cn } from "@/lib/utils";
import type { AreaDraft, LightView, Position3, SyncArea, SyncLight } from "@/types";

/** The bridge caps an area at 10 lights. */
const MAX_LIGHTS = 10;
type Kind = AreaDraft["kind"];
const KINDS: { kind: Kind; icon: typeof Music }[] = [
  { kind: "music", icon: Music },
  { kind: "screen", icon: Tv },
  { kind: "monitor", icon: Monitor },
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  syncLights: SyncLight[];
  /** Given: edit this area. Absent: create a new one. */
  area?: SyncArea;
  onSaved: (areaId: string) => void;
};

export function AreaWizard({ open, onOpenChange, syncLights, area, onSaved }: Props) {
  const { lights, rooms } = useAppState();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Kind>("music");
  const [positions, setPositions] = useState<Map<string, Position3>>(new Map());
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const serviceOf = useMemo(() => new Map(syncLights.map((l) => [l.lightId, l])), [syncLights]);

  // (Re)start from the edited area, or blank.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setError(null);
    const editedKind = (area?.kind as Kind) ?? "music";
    setKind(["music", "screen", "monitor"].includes(editedKind) ? editedKind : "screen");
    const lightOfService = new Map(syncLights.map((l) => [l.serviceId, l.lightId]));
    setPositions(
      new Map(
        (area?.members ?? []).flatMap((m) => {
          const lightId = lightOfService.get(m.serviceId);
          return lightId ? [[lightId, m.position] as const] : [];
        }),
      ),
    );
    setName(area?.name ?? "");
  }, [open, area, syncLights]);

  const selected = [...positions.keys()];
  const toggleLight = (lightId: string, on: boolean) => {
    const next = new Map(positions);
    if (on) next.set(lightId, { x: 0, y: 0, z: 0 });
    else next.delete(lightId);
    setPositions(spreadIfUnplaced(next, kind));
  };

  const isScreen = kind !== "music";
  const steps = isScreen ? 3 : 2;
  const last = step === steps - 1;

  const save = async () => {
    const draft: AreaDraft = {
      name: name.trim() || t(`sync.area.default_name.${kind}` as MessageKey),
      kind,
      members: selected.map((lightId) => ({
        serviceId: serviceOf.get(lightId)!.serviceId!,
        position: positions.get(lightId)!,
      })),
    };
    setSaving(true);
    setError(null);
    try {
      const id = area
        ? (await sync.updateArea(area.id, draft), area.id)
        : await sync.createArea(draft);
      onOpenChange(false);
      onSaved(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {area ? t("sync.area.edit_title") : t("sync.area.create_title")}
          </DialogTitle>
          <DialogDescription>
            {t("sync.area.step", { n: step + 1, total: steps })} ·{" "}
            {t(`sync.area.step_title.${step === 0 ? "kind" : step === 1 ? "lights" : "layout"}`)}
          </DialogDescription>
        </DialogHeader>

        {step === 0 && (
          <div className="grid gap-2">
            {KINDS.map(({ kind: k, icon: Icon }) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setKind(k);
                  setPositions((p) => spreadIfUnplaced(new Map(p), k, true));
                }}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none",
                  "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  kind === k ? "border-primary bg-primary/10" : "border-border",
                )}
              >
                <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <span className="block text-sm font-medium">
                    {t(`sync.area.kind.${k}` as MessageKey)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`sync.area.kind_hint.${k}` as MessageKey)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {step === 1 && (
          <LightPicker
            rooms={rooms.map((r) => ({ id: r.id, name: r.name }))}
            lights={lights}
            syncLights={serviceOf}
            selected={positions}
            onToggle={toggleLight}
          />
        )}

        {step === 2 && isScreen && (
          <LayoutEditor
            lights={lights.filter((l) => positions.has(l.id))}
            positions={positions}
            onMove={(lightId, position) => setPositions(new Map(positions).set(lightId, position))}
          />
        )}

        {last && (
          <div className="grid gap-1.5">
            <Label htmlFor="area-name">{t("sync.area.name")}</Label>
            <Input
              id="area-name"
              value={name}
              maxLength={32}
              placeholder={t(`sync.area.default_name.${kind}` as MessageKey)}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => (step === 0 ? onOpenChange(false) : setStep(step - 1))}
          >
            {step === 0 ? t("common.cancel") : t("pairing.back")}
          </Button>
          {last ? (
            <Button onClick={() => void save()} disabled={saving || selected.length === 0}>
              {saving && <Spinner />}
              {t("sync.area.save")}
            </Button>
          ) : (
            <Button
              onClick={() => setStep(step + 1)}
              disabled={step === 1 && selected.length === 0}
            >
              {t("sync.area.next")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Step 2: lights ------------------------------------------------------------

function LightPicker({
  rooms,
  lights,
  syncLights,
  selected,
  onToggle,
}: {
  rooms: { id: string; name: string }[];
  lights: LightView[];
  syncLights: Map<string, SyncLight>;
  selected: Map<string, Position3>;
  onToggle: (lightId: string, on: boolean) => void;
}) {
  const full = selected.size >= MAX_LIGHTS;
  const groups = [
    ...rooms.map((room) => ({ ...room, lights: lights.filter((l) => l.roomId === room.id) })),
    { id: "none", name: t("lights.unassigned"), lights: lights.filter((l) => !l.roomId) },
  ].filter((g) => g.lights.length > 0);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t("sync.area.lights_count", { n: selected.size, max: MAX_LIGHTS })}
      </p>
      {groups.map((group) => (
        <section key={group.id} className="space-y-1">
          <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {group.name}
          </h3>
          {group.lights.map((light) => {
            const info = syncLights.get(light.id);
            const capable = Boolean(info?.renderer && info.serviceId);
            const checked = selected.has(light.id);
            const reason = capable ? null : whyNot(light);
            return (
              <Label
                key={light.id}
                className={cn(
                  "flex items-center gap-3 rounded-md px-2 py-1.5 font-normal",
                  capable ? "cursor-pointer hover:bg-accent" : "opacity-50",
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={!capable || (!checked && full)}
                  onCheckedChange={(v) => onToggle(light.id, v === true)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{light.name}</span>
                {reason && <span className="text-[10px] text-muted-foreground">{reason}</span>}
              </Label>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function whyNot(light: LightView): string {
  const { color, temperature, dimming } = light.capabilities;
  if (!dimming && !color && !temperature) return t("sync.area.why.plug");
  if (!color) return t("sync.area.why.white");
  return t("sync.area.why.firmware");
}

// --- Step 3: layout (screen areas) -----------------------------------------------

/**
 * Top view: the screen along the top edge, the viewer at the bottom. Hue
 * positions are relative (-1..1), not meters — x left→right, y from where you
 * sit (-1) to the screen (1); height (z) stays as is. So the scale is
 * descriptive: a grid, labelled edges, and a plain-words readout.
 */
function LayoutEditor({
  lights,
  positions,
  onMove,
}: {
  lights: LightView[];
  positions: Map<string, Position3>;
  onMove: (lightId: string, position: Position3) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Light shown in the readout: being dragged, or last moved. */
  const [focus, setFocus] = useState<string | null>(null);

  const move = (event: React.PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!dragging || !rect) return;
    const x = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1);
    const y = clamp(1 - ((event.clientY - rect.top) / rect.height) * 2);
    onMove(dragging, { ...positions.get(dragging)!, x: round2(x), y: round2(y) });
  };

  const focused = lights.find((l) => l.id === focus);
  const focusedAt = focused ? positions.get(focused.id) : undefined;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("sync.area.layout_hint")}</p>

      <div className="flex gap-1.5">
        {/* Ruler: distance from the screen */}
        <div className="flex w-14 shrink-0 flex-col justify-between py-0.5 text-right text-[9px] leading-tight text-muted-foreground">
          <span>{t("sync.area.scale.at_screen")}</span>
          <span>{t("sync.area.scale.halfway")}</span>
          <span>{t("sync.area.scale.you")}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div
            ref={box}
            onPointerMove={move}
            onPointerUp={() => setDragging(null)}
            className="relative aspect-square touch-none rounded-lg border border-border bg-muted/40 select-none"
          >
            {/* Grid every 0.5 units; the center lines stronger */}
            {[25, 50, 75].map((pct) => (
              <div key={`v${pct}`} aria-hidden>
                <div
                  className={cn(
                    "absolute inset-y-0 w-px",
                    pct === 50 ? "bg-border" : "bg-border/50",
                  )}
                  style={{ left: `${pct}%` }}
                />
                <div
                  className={cn(
                    "absolute inset-x-0 h-px",
                    pct === 50 ? "bg-border" : "bg-border/50",
                  )}
                  style={{ top: `${pct}%` }}
                />
              </div>
            ))}
            {/* The screen */}
            <div
              className="absolute inset-x-[20%] top-1 h-1.5 rounded-sm bg-foreground/60"
              aria-hidden
            />

            {lights.map((light) => {
              const p = positions.get(light.id)!;
              return (
                // Dot and label move together; either can be dragged.
                <div
                  key={light.id}
                  title={light.name}
                  onPointerDown={(e) => {
                    setDragging(light.id);
                    setFocus(light.id);
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  }}
                  className={cn(
                    "absolute flex -translate-x-1/2 -translate-y-2.5 cursor-grab flex-col items-center gap-0.5 active:cursor-grabbing",
                    dragging === light.id ? "z-10" : "z-0",
                  )}
                  style={{ left: `${((p.x + 1) / 2) * 100}%`, top: `${((1 - p.y) / 2) * 100}%` }}
                >
                  <span
                    className="size-5 rounded-full ring-2 ring-background"
                    style={{ backgroundColor: light.color ? toCss(light.color) : "var(--primary)" }}
                    aria-hidden
                  />
                  <span className="max-w-24 truncate rounded bg-background/80 px-1 text-[10px] leading-4">
                    {light.name}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Ruler: left / center / right */}
          <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
            <span>{t("sync.area.scale.left")}</span>
            <span>{t("sync.area.scale.center")}</span>
            <span>{t("sync.area.scale.right")}</span>
          </div>
        </div>
      </div>

      <p className="min-h-4 text-xs" aria-live="polite">
        {focused && focusedAt
          ? t("sync.area.where", {
              name: focused.name,
              x: t(`sync.area.where_x.${sideOf(focusedAt.x)}` as MessageKey),
              y: t(`sync.area.where_y.${depthOf(focusedAt.y)}` as MessageKey),
            })
          : ""}
      </p>
    </div>
  );
}

function sideOf(x: number): "left" | "center" | "right" {
  return x < -0.33 ? "left" : x > 0.33 ? "right" : "center";
}

function depthOf(y: number): "screen" | "halfway" | "near_you" {
  return y > 0.5 ? "screen" : y < -0.5 ? "near_you" : "halfway";
}

/**
 * Lights without a place yet get spread evenly left→right — along the back of
 * the screen for screen areas, across the middle for music.
 */
function spreadIfUnplaced(
  positions: Map<string, Position3>,
  kind: Kind,
  force = false,
): Map<string, Position3> {
  const ids = [...positions.keys()];
  const unplaced = ids.filter((id) => {
    const p = positions.get(id)!;
    return force || (p.x === 0 && p.y === 0 && p.z === 0);
  });
  if (unplaced.length === 0) return positions;
  const y = kind === "music" ? 0 : 0.9;
  ids.forEach((id, i) => {
    if (!unplaced.includes(id)) return;
    const x = ids.length === 1 ? 0 : -0.8 + (1.6 * i) / (ids.length - 1);
    positions.set(id, { x: round2(x), y, z: 0 });
  });
  return positions;
}

function clamp(v: number): number {
  return Math.min(1, Math.max(-1, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
