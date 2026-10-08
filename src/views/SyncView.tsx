// The Sync tab. Two states: a readiness checklist until everything light sync
// needs is in place, then the controls - area, mode, colors, intensity (with
// its advanced settings), and a big Start/Stop - with a live preview of what the
// lights show. Intensity and its advanced settings stay live while syncing.
//
// The engine runs in Rust; everything here goes through core/sync.ts.

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  CircleAlert,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ScreenPreview } from "@/components/sync/ScreenPreview";
import { SpectrumBars } from "@/components/sync/SpectrumBars";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { actions } from "@/core/app";
import { sync } from "@/core/sync";
import { useAppState } from "@/core/useAppState";
import { useSyncState } from "@/core/useSyncState";
import { t, type MessageKey } from "@/i18n";
import { toHex } from "@/lib/color";
import { POPULAR_PALETTES } from "@/lib/palettes";
import { paletteBackground, paletteHex, scenePreview } from "@/lib/presets";
import { applyPatch, INTENSITY_LEVELS, presetTuning } from "@/lib/tuning";
import { cn } from "@/lib/utils";
import type {
  AudioSource,
  IntensityLevel,
  Monitor as MonitorInfo,
  MusicStyle,
  ReadinessCheck,
  SyncArea,
  SyncMode,
  SyncTuning,
} from "@/types";

type Props = { onRepair: () => void };

export function SyncView({ onRepair }: Props) {
  const { status, overview, loading, error } = useSyncState();
  const [wizard, setWizard] = useState<{ open: boolean; area?: SyncArea }>({ open: false });

  useEffect(() => {
    void sync.refresh();
    void sync.refreshAudioDevices();
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

  // Ready: the controls lay out their own scrolling part and bottom bar.
  if (overview && (overview.ready || status.state === "streaming")) {
    return (
      <>
        <SyncControls
          areas={overview.areas}
          onNewArea={() => setWizard({ open: true })}
          onEditArea={(area) => setWizard({ open: true, area })}
        />
        {wizardDialog}
      </>
    );
  }

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

        {wizardDialog}
      </div>
    </ScrollArea>
  );
}

// --- Controls ------------------------------------------------------------------

/** One text size for every select in the Sync tab (as in "Sound from"). */
const SELECT_TEXT = "text-xs font-medium";
/** Secondary text inside select items: light counts, sizes, device names. */
const SELECT_NOTE = "text-[11px] font-normal text-muted-foreground";

const MODES: { mode: SyncMode; icon: typeof Music; available: boolean }[] = [
  { mode: "ambient", icon: Sparkles, available: true },
  { mode: "music", icon: Music, available: true },
  { mode: "screen", icon: Monitor, available: true },
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
  const { status, preview, overview, audioLost, reconnecting, monitors } = useSyncState();
  const audioCheck = overview?.checks.find((c) => c.id === "audio");
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

  // A stored mode this machine can't run (no audio / no X11) falls back to ambient.
  const audioOk = overview?.audioSupported !== false;
  const screenOk = overview?.screenSupported !== false;
  const mode: SyncMode =
    syncPrefs.mode === "music" && audioOk
      ? "music"
      : syncPrefs.mode === "screen" && screenOk
        ? "screen"
        : "ambient";
  const screenCheck = overview?.checks.find((c) => c.id === "screen");
  // Why a mode is off on this machine - shown next to the "Mode" heading.
  const unavailableModes = [
    ...(!audioOk ? [{ mode: "music" as const, why: t("sync.mode_unavailable_build") }] : []),
    ...(!screenOk
      ? [
          {
            mode: "screen" as const,
            why: screenCheck?.params?.reason
              ? t(`sync.check.screen.${screenCheck.params.reason}` as MessageKey)
              : t("sync.mode_unavailable_build"),
          },
        ]
      : []),
  ];

  const start = (takeOver = false) => {
    if (!area) return;
    void sync.start({
      areaId: area.id,
      mode,
      palette: source.colors,
      tuning: syncPrefs.tuning[mode],
      restore: syncPrefs.restore,
      style: syncPrefs.musicStyle,
      source: syncPrefs.audioSource,
      monitor: syncPrefs.screenMonitor,
      safeMode: syncPrefs.safeMode,
      takeOver,
    });
  };

  if (!area) return null;
  const showBars = status.state === "streaming" && mode === "music";
  const showScreen = status.state === "streaming" && mode === "screen";
  const monitor =
    monitors?.find((m) => m.name === syncPrefs.screenMonitor) ??
    monitors?.find((m) => m.primary) ??
    monitors?.[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {/* Area */}
          <Field label={t("sync.area.label")}>
            <div className="flex gap-1.5">
              <Select
                value={area.id}
                disabled={busy}
                onValueChange={(areaId) => void actions.setSyncPrefs({ areaId })}
              >
                <SelectTrigger
                  className={cn("min-w-0 flex-1", SELECT_TEXT)}
                  aria-label={t("sync.area.label")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {areas.map((a) => (
                    <SelectItem key={a.id} value={a.id} className={SELECT_TEXT}>
                      {a.name}
                      <span className={SELECT_NOTE}>
                        {t("sync.area.lights_in", { count: a.lightIds.length })}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <IconButton label={t("sync.area.new")} disabled={busy} onClick={onNewArea}>
                <Plus />
              </IconButton>
              <IconButton
                label={t("sync.area.edit")}
                disabled={busy}
                onClick={() => onEditArea(area)}
              >
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
          <Field label={t("sync.mode.label")} aside={<ModeWarnings reasons={unavailableModes} />}>
            <div className="grid grid-cols-3 gap-1.5">
              {MODES.map(({ mode: m, icon: Icon, available: planned }) => {
                const unsupported = (m === "music" && !audioOk) || (m === "screen" && !screenOk);
                const available = planned && !unsupported;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={!available || busy}
                    onClick={() => void actions.setSyncPrefs({ mode: m })}
                    className={cn(
                      // Grid rows stretch every tile to the tallest one; keep the
                      // content in the middle of each.
                      "flex flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2.5 text-center text-xs transition-colors outline-none",
                      "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                      mode === m && available
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    <span className="font-medium">{t(`sync.mode.${m}` as MessageKey)}</span>
                    {!available && (
                      <span className="text-[10px] text-muted-foreground">
                        {unsupported ? t("sync.mode_unavailable") : t("sync.coming_soon")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">{t(`sync.mode_hint.${mode}`)}</p>
          </Field>

          {mode === "music" && <MusicSettings disabled={busy} audioCheck={audioCheck} />}
          {mode === "screen" && <ScreenSettings disabled={busy} />}

          {/* Colors - the screen brings its own */}
          {mode !== "screen" && (
            <Field label={t("sync.colors")}>
              <Select
                value={source.id}
                disabled={busy}
                onValueChange={(colorsFrom) => void actions.setSyncPrefs({ colorsFrom })}
              >
                <SelectTrigger className={cn("w-full", SELECT_TEXT)} aria-label={t("sync.colors")}>
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
                          <SelectItem key={c.id} value={c.id} className={SELECT_TEXT}>
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
          )}
        </div>
      </ScrollArea>

      {/* What the lights show, standing on the bottom bar: the spectrum for
          music, a miniature of the screen for screen sync, the lights'
          colors for ambient. */}
      {status.state === "streaming" && mode === "ambient" && preview.length > 0 && (
        <LiveLights colors={preview} />
      )}
      {showBars && <SpectrumBars colors={source.colors} />}
      {showScreen && (
        <ScreenPreview
          colors={preview}
          aspect={monitor ? monitor.width / monitor.height : 16 / 9}
        />
      )}

      {/* Pinned to the bottom: always in reach, whatever is scrolled above.
          pb-8 clears the app footer bar, which overlays the window's bottom. */}
      <div className="shrink-0 space-y-3 border-t border-border bg-background/70 px-3 pt-3 pb-8 backdrop-blur-sm">
        <TuningControls
          mode={mode}
          tuning={syncPrefs.tuning[mode]}
          beats={mode === "music" && syncPrefs.musicStyle === "pulse"}
          open={syncPrefs.advancedOpen}
        />

        {/* Error */}
        {/* Declining the screen-sharing dialog is a choice, not a failure. */}
        {status.state === "error" && status.code === "screen_cancelled" && (
          <p className="text-center text-xs text-muted-foreground">{t("sync.screen_cancelled")}</p>
        )}
        {status.state === "error" && status.code !== "screen_cancelled" && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3"
          >
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

        {status.state === "streaming" && (reconnecting || audioLost) && (
          <p
            className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <Spinner className="size-3" />
            {reconnecting
              ? t("sync.reconnecting")
              : mode === "screen"
                ? t("sync.screen_waiting")
                : t("sync.audio_waiting")}
          </p>
        )}
      </div>

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

// --- Screen settings ---------------------------------------------------------

function ScreenSettings({ disabled }: { disabled: boolean }) {
  const { overview } = useSyncState();
  return overview?.screenPortal ? <PortalScreen disabled={disabled} /> : <MonitorPicker disabled={disabled} />;
}

/**
 * Wayland: apps can't pick a monitor themselves - the system's sharing
 * dialog does. "Change screen…" opens it now; the choice is remembered, and
 * shown here (the dialog tells us its size, not its name).
 */
function PortalScreen({ disabled }: { disabled: boolean }) {
  const { overview } = useSyncState();
  const [picking, setPicking] = useState(false);
  const shared = overview?.sharedScreen ?? null;
  const size = shared && shared.width > 0 ? t("sync.monitor_size", { width: shared.width, height: shared.height }) : null;

  return (
    <Field label={t("sync.monitor")}>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
        <p className="min-w-0 text-xs">
          {shared ? (
            <>
              <span className="font-medium">{t("sync.screen_shared")}</span>
              {size && <span className="text-muted-foreground"> · {size}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{t("sync.screen_pick_hint")}</span>
          )}
        </p>
        <Button
          size="xs"
          variant="secondary"
          className="shrink-0"
          disabled={disabled || picking}
          onClick={() => {
            setPicking(true);
            void sync.pickScreen().finally(() => setPicking(false));
          }}
        >
          {picking ? <Spinner /> : null}
          {t("sync.screen_change")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("sync.screen_hint")}</p>
    </Field>
  );
}

/** X11: a monitor from RandR. */
function MonitorPicker({ disabled }: { disabled: boolean }) {
  const { syncPrefs } = useAppState();
  const { monitors } = useSyncState();

  useEffect(() => {
    void sync.refreshMonitors();
  }, []);

  const label = (m: MonitorInfo) =>
    `${m.name} · ${t("sync.monitor_size", { width: m.width, height: m.height })}`;
  // null in prefs = "the primary one"; show it selected as such.
  const selected =
    monitors?.find((m) => m.name === syncPrefs.screenMonitor)?.name ??
    monitors?.find((m) => m.primary)?.name ??
    monitors?.[0]?.name;

  return (
    <Field label={t("sync.monitor")}>
      <Select
        value={selected}
        disabled={disabled || !monitors?.length}
        onOpenChange={(open) => open && void sync.refreshMonitors()}
        onValueChange={(screenMonitor) => void actions.setSyncPrefs({ screenMonitor })}
      >
        <SelectTrigger className={cn("w-full", SELECT_TEXT)} aria-label={t("sync.monitor")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {monitors?.map((m) => (
            <SelectItem key={m.name} value={m.name} className={SELECT_TEXT}>
              {label(m)}
              {m.primary && <span className={SELECT_NOTE}>{t("sync.monitor_primary")}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t("sync.screen_hint")}</p>
    </Field>
  );
}

// --- Music settings --------------------------------------------------------------

const STYLES: MusicStyle[] = ["pulse", "spectrum"];
const SOURCES: AudioSource[] = ["system", "microphone"];

function MusicSettings({
  disabled,
  audioCheck,
}: {
  disabled: boolean;
  audioCheck?: ReadinessCheck;
}) {
  const { syncPrefs } = useAppState();
  const { audioDevices } = useSyncState();
  const deviceName = (source: AudioSource) =>
    source === "system" ? audioDevices?.system : audioDevices?.microphone;
  const reason = audioCheck?.level === "warning" ? audioCheck.params?.reason : undefined;

  return (
    <>
      <Field label={t("sync.source")}>
        <Select
          value={syncPrefs.audioSource}
          disabled={disabled}
          // Re-read on open: the user may have switched devices in the system.
          onOpenChange={(open) => open && void sync.refreshAudioDevices()}
          onValueChange={(audioSource) =>
            void actions.setSyncPrefs({ audioSource: audioSource as AudioSource })
          }
        >
          <SelectTrigger className="h-auto min-h-[37px] w-full py-2" aria-label={t("sync.source")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((source) => {
              const name = deviceName(source);
              return (
                <SelectItem key={source} value={source} title={name ?? undefined}>
                  {/* Label, and under it the device the desktop shows for it. */}
                  <span className="flex min-w-0 flex-col items-start text-left">
                    <span className={SELECT_TEXT}>{t(`sync.source.${source}`)}</span>
                    {name && <span className={cn("max-w-64 truncate", SELECT_NOTE)}>{name}</span>}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {reason && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t(`sync.check.audio.${reason}` as MessageKey)}
          </p>
        )}
        {syncPrefs.audioSource === "microphone" && audioDevices?.microphoneBluetooth && (
          <p className="text-xs text-muted-foreground">{t("sync.bluetooth_mic_hint")}</p>
        )}
      </Field>

      <Field label={t("sync.style")}>
        <Segmented
          options={STYLES.map((style) => ({ value: style, label: t(`sync.style.${style}`) }))}
          value={syncPrefs.musicStyle}
          disabled={disabled}
          onChange={(musicStyle) => void actions.setSyncPrefs({ musicStyle })}
        />
        <p className="text-xs text-muted-foreground">
          {t(`sync.style_hint.${syncPrefs.musicStyle}`)}
        </p>
      </Field>
    </>
  );
}

// --- Intensity and advanced settings ---------------------------------------------

/**
 * Intensity picks a preset for the current mode; Advanced settings opens the
 * settings it sets. Both work while syncing: the lights follow at once.
 * Sliders send every step, and save once let go.
 */
function TuningControls({
  mode,
  tuning,
  beats,
  open,
}: {
  mode: SyncMode;
  tuning: SyncTuning;
  /** Sensitivity only matters where beats do: music in the Pulse style. */
  beats: boolean;
  open: boolean;
}) {
  const set = (patch: Partial<Omit<SyncTuning, "intensity">>, commit: boolean) =>
    void actions.setSyncTuning(mode, applyPatch(tuning, patch), commit);

  return (
    <Collapsible
      open={open}
      onOpenChange={(advancedOpen) => void actions.setSyncPrefs({ advancedOpen })}
      className="space-y-3"
    >
      <Field
        label={t("sync.intensity")}
        aside={
          <>
            {tuning.intensity === null && (
              <span className="text-[11px] text-muted-foreground">
                · {t("sync.intensity.custom")}
              </span>
            )}
            <CollapsibleTrigger className="ml-auto flex items-center gap-0.5 rounded-sm text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {t("sync.advanced")}
              <ChevronDown
                className={cn("size-3.5 transition-transform", open && "rotate-180")}
                aria-hidden
              />
            </CollapsibleTrigger>
          </>
        }
      >
        <Segmented
          options={INTENSITY_LEVELS.map((level) => ({
            value: String(level),
            label: t(`sync.intensity.${level}` as MessageKey),
          }))}
          value={String(tuning.intensity ?? "custom")}
          onChange={(level) =>
            void actions.setSyncTuning(mode, presetTuning(mode, Number(level) as IntensityLevel), true)
          }
        />
      </Field>

      <CollapsibleContent className="overflow-hidden data-open:animate-collapsible-down data-closed:animate-collapsible-up">
        {/* Padding, not the last row's margin: it counts in the height Radix
            measures, so the last slider isn't cut off. */}
        <div className="space-y-2.5 pb-2">
          <TuneSlider
            label={t("sync.tune.brightness")}
            hint={t("sync.tune.brightness_hint")}
            value={tuning.brightness}
            shown={`${Math.round(tuning.brightness[0])}–${Math.round(tuning.brightness[1])}%`}
            onChange={([min, max], commit) => set({ brightness: [min!, max!] }, commit)}
          />
          <TuneSlider
            label={t("sync.tune.speed")}
            hint={t(`sync.tune.speed_hint.${mode}`)}
            value={[tuning.speed]}
            shown={`${Math.round(tuning.speed)}%`}
            onChange={([speed], commit) => set({ speed: speed! }, commit)}
          />
          <TuneSlider
            label={t("sync.tune.vividness")}
            hint={t(`sync.tune.vividness_hint.${mode}`)}
            value={[tuning.vividness]}
            shown={`${Math.round(tuning.vividness)}%`}
            onChange={([vividness], commit) => set({ vividness: vividness! }, commit)}
          />
          {beats && (
            <TuneSlider
              label={t("sync.tune.sensitivity")}
              hint={t("sync.tune.sensitivity_hint")}
              value={[tuning.sensitivity]}
              shown={`${Math.round(tuning.sensitivity)}%`}
              onChange={([sensitivity], commit) => set({ sensitivity: sensitivity! }, commit)}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TuneSlider({
  label,
  hint,
  value,
  shown,
  onChange,
}: {
  label: string;
  hint: string;
  /** One value, or two for a range. */
  value: number[];
  /** The value as text, next to the label. */
  shown: string;
  onChange: (value: number[], commit: boolean) => void;
}) {
  return (
    <div className="space-y-1" title={hint}>
      <div className="flex items-baseline justify-between text-xs">
        <span>{label}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{shown}</span>
      </div>
      <Slider
        value={value}
        min={0}
        max={100}
        step={1}
        minStepsBetweenThumbs={value.length > 1 ? 5 : undefined}
        aria-label={label}
        onValueChange={(v) => onChange(v, false)}
        onValueCommit={(v) => onChange(v, true)}
      />
    </div>
  );
}

/** Ambient: the lights' current colors. */
function LiveLights({ colors }: { colors: string[] }) {
  return (
    <div className="flex items-center justify-center gap-2 px-3 pb-3" aria-label={t("sync.live")}>
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t("sync.live")}
      </span>
      {colors.map((hex, i) => (
        <span
          key={i}
          className="size-5 rounded-full ring-1 ring-border transition-colors duration-100"
          style={{ backgroundColor: hex, boxShadow: `0 0 12px ${hex}` }}
        />
      ))}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  disabled,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="grid gap-1 rounded-lg bg-muted p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="radiogroup"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            value === option.value
              ? "bg-background font-medium shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Field({
  label,
  aside,
  children,
}: {
  label: string;
  /** Next to the heading, e.g. a warning icon. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A warning icon by "Mode" when some mode can't run here; hover for why. */
function ModeWarnings({ reasons }: { reasons: { mode: SyncMode; why: string }[] }) {
  if (reasons.length === 0) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="rounded-full text-amber-500 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("sync.mode_unavailable_label")}
          >
            <CircleAlert className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-64 space-y-1 text-xs">
          {reasons.map(({ mode, why }) => (
            <p key={mode}>
              <span className="font-semibold">{t(`sync.mode.${mode}` as MessageKey)}</span> - {why}
            </p>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
