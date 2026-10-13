// Create or edit a sync area (an Entertainment configuration on the bridge):
//   1. what it is for (music / TV / desk monitor)
//   2. which lights - only those that can stream; the rest are shown with why not
//   3. where they are: placed in a small room (LayoutRoom), the dialog
//      filling the window. For music only the left-to-right order counts.
// "Edit layout" opens step 3 alone, for an existing area.
// Areas made here and in the Philips Hue app are the same bridge resources.

import { useEffect, useMemo, useState } from "react";
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
import { LayoutRoom } from "@/components/sync/LayoutRoom";
import { useAppState } from "@/core/useAppState";
import { sync } from "@/core/sync";
import { t, type MessageKey } from "@/i18n";
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
  /** Only the layout of `area`: its name and kind stay. */
  layoutOnly?: boolean;
  onSaved: (areaId: string) => void;
};

export function AreaWizard({ open, onOpenChange, syncLights, area, layoutOnly, onSaved }: Props) {
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
    setStep(layoutOnly ? 2 : 0);
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
  }, [open, area, syncLights, layoutOnly]);

  const selected = [...positions.keys()];
  const toggleLight = (lightId: string, on: boolean) => {
    const next = new Map(positions);
    if (on) next.set(lightId, { x: 0, y: 0, z: 0 });
    else next.delete(lightId);
    setPositions(spreadIfUnplaced(next, kind));
  };

  const steps = 3;
  const last = step === steps - 1;
  const first = layoutOnly ? 2 : 0;
  const placing = step === 2;

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
      {/* Placing lights needs room: the dialog grows to fill the window. */}
      <DialogContent
        className={cn(
          "sm:max-w-sm",
          placing && "h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-[calc(100%-2rem)]",
        )}
      >
        <DialogHeader>
          <DialogTitle>
            {layoutOnly
              ? t("sync.area.layout_title")
              : area
                ? t("sync.area.edit_title")
                : t("sync.area.create_title")}
          </DialogTitle>
          <DialogDescription>
            {layoutOnly
              ? area?.name
              : `${t("sync.area.step", { n: step + 1, total: steps })} · ${t(
                  `sync.area.step_title.${step === 0 ? "kind" : step === 1 ? "lights" : "layout"}`,
                )}`}
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

        {placing && (
          <div className="flex min-h-0 flex-col gap-3">
            <LayoutRoom
              kind={kind}
              lights={lights.filter((l) => positions.has(l.id))}
              positions={positions}
              onMove={(lightId, position) =>
                setPositions((current) => new Map(current).set(lightId, position))
              }
            />
            {!layoutOnly && (
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
            onClick={() => (step === first ? onOpenChange(false) : setStep(step - 1))}
          >
            {step === first ? t("common.cancel") : t("pairing.back")}
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

/**
 * Lights without a place yet get spread evenly left->right - along the back of
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
