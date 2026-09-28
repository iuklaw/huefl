// The Sync tab. Two states: a readiness checklist until everything light sync
// needs is in place, then the controls — area, mode, colors, intensity, and a
// big Start/Stop — with a live preview of what the lights show.
//
// The engine runs in Rust; everything here goes through core/sync.ts.

import { useEffect, useMemo, useState } from "react";
import {
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Monitor,
  Music,
} from "lucide-react";
import { AreaWizard } from "@/components/sync/AreaWizard";
import { Readiness } from "@/components/sync/Readiness";
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
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { actions } from "@/core/app";
import { sync } from "@/core/sync";
import { useAppState } from "@/core/useAppState";
import { useSyncState } from "@/core/useSyncState";
import { t, type MessageKey } from "@/i18n";
import { toHex } from "@/lib/color";
import { POPULAR_PALETTES } from "@/lib/palettes";
import { paletteBackground, paletteHex, scenePreview } from "@/lib/presets";
import { cn } from "@/lib/utils";
import type { SyncArea, SyncMode } from "@/types";

type Props = { onRepair: () => void };

export function SyncView({ onRepair }: Props) {
  const { status, overview, loading, error } = useSyncState();
  const [wizard, setWizard] = useState<{ open: boolean; area?: SyncArea }>({ open: false });

  useEffect(() => {
    void sync.refresh();
  }, []);

  const wizardDialog = overview && (
    <AreaWizard
      open={wizard.open}
      area={wizard.area}
      syncLights={overview.lights}
      onOpenChange={(open) => setWizard((w) => ({ ...w, open }))}
      onSaved={(areaId) => void actions.setSyncPrefs({ areaId })}
    />
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-4 p-3 pb-10">
        {!overview && loading && (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Spinner className="size-6" />
          </div>
        )}

        {!overview && error && (
          <div className="space-y-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">{t("sync.load_failed")}</p>
            <p data-selectable className="text-xs text-muted-foreground">
              {error}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void sync.refresh()}>
              <RefreshCw />
              {t("status.retry")}
            </Button>
          </div>
        )}

        {overview && !overview.ready && status.state !== "streaming" && (
          <section className="space-y-3">
            <div>
              <h1 className="text-sm font-semibold">{t("sync.setup_title")}</h1>
              <p className="text-xs text-muted-foreground">{t("sync.setup_hint")}</p>
            </div>
            <Readiness
              checks={overview.checks}
              onCreateArea={() => setWizard({ open: true })}
              onRepair={onRepair}
            />
          </section>
        )}

        {overview && (overview.ready || status.state === "streaming") && (
          <SyncControls
            areas={overview.areas}
            onNewArea={() => setWizard({ open: true })}
            onEditArea={(area) => setWizard({ open: true, area })}
          />
        )}

        {wizardDialog}
      </div>
    </ScrollArea>
  );
}

// --- Controls ------------------------------------------------------------------

const MODES: { mode: SyncMode; icon: typeof Music; available: boolean }[] = [
  { mode: "ambient", icon: Sparkles, available: true },
  { mode: "music", icon: Music, available: false },
  { mode: "screen", icon: Monitor, available: false },
];

function SyncControls({
  areas,
  onNewArea,
  onEditArea,
}: {
  areas: SyncArea[];
  onNewArea: () => void;
  onEditArea: (area: SyncArea) => void;
}) {
  const { status, preview } = useSyncState();
  const { syncPrefs, library } = useAppState();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const area = areas.find((a) => a.id === syncPrefs.areaId) ?? areas[0];
  const running = status.state === "starting" || status.state === "streaming";
  const busy = running || status.state === "stopping";

  // Colors come from a popular palette or a saved preset.
  const colorSources = useMemo(
    () => [
      ...POPULAR_PALETTES.map((p) => ({
        id: `palette:${p.id}`,
        group: "popular" as const,
        name: t(`palette.${p.id}` as MessageKey),
        colors: paletteHex(p),
        background: paletteBackground(p),
      })),
      ...library.scenes.map((s) => {
        const colors = scenePreview(s, 8).map(toHex);
        return {
          id: `scene:${s.id}`,
          group: "saved" as const,
          name: s.name,
          colors,
          background:
            colors.length > 1
              ? `linear-gradient(to right, ${colors.join(", ")})`
              : (colors[0] ?? "transparent"),
        };
      }),
    ],
    [library.scenes],
  );
  const source = colorSources.find((c) => c.id === syncPrefs.colorsFrom) ?? colorSources[0]!;

  const start = (takeOver = false) => {
    if (!area) return;
    void sync.start({
      areaId: area.id,
      mode: "ambient",
      palette: source.colors,
      intensity: syncPrefs.intensity,
      restore: syncPrefs.restore,
      takeOver,
    });
  };

  if (!area) return null;

  return (
    <div className="space-y-4">
      {/* Area */}
      <Field label={t("sync.area.label")}>
        <div className="flex gap-1.5">
          <Select
            value={area.id}
            disabled={busy}
            onValueChange={(areaId) => void actions.setSyncPrefs({ areaId })}
          >
            <SelectTrigger className="min-w-0 flex-1" aria-label={t("sync.area.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {areas.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  <span className="text-xs text-muted-foreground">
                    {t("sync.area.lights_in", { count: a.lightIds.length })}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <IconButton label={t("sync.area.new")} disabled={busy} onClick={onNewArea}>
            <Plus />
          </IconButton>
          <IconButton label={t("sync.area.edit")} disabled={busy} onClick={() => onEditArea(area)}>
            <Pencil />
          </IconButton>
          <IconButton
            label={t("sync.area.delete")}
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
          </IconButton>
        </div>
      </Field>

      {/* Mode */}
      <Field label={t("sync.mode.label")}>
        <div className="grid grid-cols-3 gap-1.5">
          {MODES.map(({ mode, icon: Icon, available }) => (
            <button
              key={mode}
              type="button"
              disabled={!available || busy}
              onClick={() => void actions.setSyncPrefs({ mode })}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                syncPrefs.mode === mode && available
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent",
              )}
            >
              <Icon className="size-4" aria-hidden />
              <span className="font-medium">{t(`sync.mode.${mode}` as MessageKey)}</span>
              {!available && (
                <span className="text-[10px] text-muted-foreground">{t("sync.coming_soon")}</span>
              )}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("sync.mode_hint.ambient")}</p>
      </Field>

      {/* Colors */}
      <Field label={t("sync.colors")}>
        <Select
          value={source.id}
          disabled={busy}
          onValueChange={(colorsFrom) => void actions.setSyncPrefs({ colorsFrom })}
        >
          <SelectTrigger className="w-full" aria-label={t("sync.colors")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["popular", "saved"] as const).map((group) => {
              const items = colorSources.filter((c) => c.group === group);
              if (items.length === 0) return null;
              return (
                <SelectGroup key={group}>
                  <SelectLabel>{t(`presets.${group}`)}</SelectLabel>
                  {items.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span
                        className="h-3 w-6 rounded-sm ring-1 ring-border"
                        style={{ background: c.background }}
                        aria-hidden
                      />
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              );
            })}
          </SelectContent>
        </Select>
      </Field>

      {/* Intensity */}
      <Field label={t("sync.intensity")}>
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1" role="radiogroup">
          {[0, 1, 2, 3].map((level) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={syncPrefs.intensity === level}
              disabled={busy}
              onClick={() => void actions.setSyncPrefs({ intensity: level })}
              className={cn(
                "rounded-md py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                syncPrefs.intensity === level
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`sync.intensity.${level}` as MessageKey)}
            </button>
          ))}
        </div>
      </Field>

      {/* Error */}
      {status.state === "error" && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
          <p className="text-sm font-semibold">{t("sync.error.title")}</p>
          <p data-selectable className="mt-0.5 text-xs text-muted-foreground">
            {status.message}
          </p>
          {status.code === "busy" && (
            <Button size="sm" className="mt-2" onClick={() => start(true)}>
              {t("sync.take_over")}
            </Button>
          )}
        </div>
      )}

      {/* Start / Stop */}
      <Button
        size="lg"
        className="h-11 w-full text-sm"
        variant={running ? "secondary" : "default"}
        disabled={status.state === "stopping" || status.state === "starting"}
        onClick={() => (running ? void sync.stop() : start())}
      >
        {status.state === "starting" || status.state === "stopping" ? (
          <Spinner />
        ) : running ? (
          <Square />
        ) : (
          <Play />
        )}
        {status.state === "starting"
          ? t("sync.starting")
          : status.state === "stopping"
            ? t("sync.stopping")
            : running
              ? t("sync.stop")
              : t("sync.start")}
      </Button>

      {/* Live preview */}
      {status.state === "streaming" && preview.length > 0 && (
        <div className="flex items-center justify-center gap-2" aria-label={t("sync.live")}>
          <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("sync.live")}
          </span>
          {preview.map((hex, i) => (
            <span
              key={i}
              className="size-5 rounded-full ring-1 ring-border transition-colors duration-100"
              style={{ backgroundColor: hex, boxShadow: `0 0 12px ${hex}` }}
            />
          ))}
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sync.area.delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sync.area.delete_description", { name: area.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void sync.deleteArea(area.id)}>
              {t("sync.area.delete_confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h2>
      {children}
    </section>
  );
}

function IconButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button size="icon" variant="ghost" title={label} aria-label={label} {...props}>
      {children}
    </Button>
  );
}
