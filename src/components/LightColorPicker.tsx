// The expanded part of a light row: a color wheel (hue + saturation) on the
// left, this light's recent colors on the right, and the chosen color in RGB below.
//
// Brightness stays on the row's slider, as in the Hue app - the wheel always
// works at full value. Picked colors are converted to CIE xy and clamped to
// this light's gamut (older lights cannot show every color).
//
// Lights without color support get a short note and their current white.

import { useEffect, useRef, useState } from "react";
import { hsvaToRgba, rgbaToHsva, type HsvaColor } from "@uiw/color-convert";
import Wheel from "@uiw/react-color-wheel";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { actions } from "@/core/app";
import { useAppState } from "@/core/useAppState";
import { log } from "@/core/log";
import { t } from "@/i18n";
import {
  DEFAULT_WHITE_MIREK,
  hexToRgb,
  mirekToRgb,
  rgbToXy,
  toCss,
  toHex,
  type Rgb,
  type Xy,
} from "@/lib/color";
import { MATCH_XY } from "@/lib/presets";
import { cn } from "@/lib/utils";
import type { LightView } from "@/types";

const WHEEL_SIZE = 120;
/** A color joins the history only after the user has settled on it. */
const HISTORY_DEBOUNCE_MS = 1_500;

export function LightColorPicker({ light }: { light: LightView }) {
  if (!light.capabilities.color) return <WhiteOnly light={light} />;
  return <ColorWheel light={light} />;
}

function ColorWheel({ light }: { light: LightView }) {
  // The last color picked here, kept after release while the bridge reports
  // (roughly) the same xy - converting back from xy would make the pointer jump.
  const [picked, setPicked] = useState<{ hsva: HsvaColor; xy: Xy } | null>(null);
  const dragging = useRef(false);
  const latest = useRef<Rgb | null>(null);
  const history = useAppState().library.colorHistory[light.id] ?? [];

  // History debounce: armed on release, reset by the next drag, flushed on
  // unmount (collapsing the row) so a settled color is never lost.
  const pendingHistory = useRef<{ hex: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelPendingHistory = () => {
    if (pendingHistory.current) clearTimeout(pendingHistory.current.timer);
    pendingHistory.current = null;
  };
  const scheduleHistory = (hex: string) => {
    cancelPendingHistory();
    const timer = setTimeout(() => {
      pendingHistory.current = null;
      void actions.rememberColor(light.id, hex);
    }, HISTORY_DEBOUNCE_MS);
    pendingHistory.current = { hex, timer };
  };
  useEffect(
    () => () => {
      const pending = pendingHistory.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      void actions.rememberColor(light.id, pending.hex);
    },
    [light.id],
  );

  const applyHistoryColor = (hex: string) => {
    const rgb = hexToRgb(hex);
    const xy = rgbToXy(rgb, light.gamut ?? undefined);
    setPicked({ hsva: { ...rgbaToHsva({ ...rgb, a: 1 }), v: 100 }, xy });
    void actions.setLight({ id: light.id, xy, on: true });
    log.info("command", "command.user", `${light.name}: color ${hex} (from history)`, {
      origin: "ui",
      light: { id: light.id, name: light.name },
      hex,
    });
  };

  // Bridge-reported xy close to what we sent counts as "ours" (gamut rounding).
  const ours =
    picked !== null &&
    light.xy !== null &&
    Math.abs(light.xy.x - picked.xy.x) < MATCH_XY &&
    Math.abs(light.xy.y - picked.xy.y) < MATCH_XY;
  const current = light.color ?? { r: 255, g: 255, b: 255 };
  const hsva =
    picked && (ours || dragging.current) ? picked.hsva : rgbaToHsva({ ...current, a: 1 });
  const shown: Rgb = picked && (ours || dragging.current) ? toRgb(picked.hsva) : current;

  // The wheel has no "change end" event; a window pointerup ends the drag.
  useEffect(() => {
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (latest.current) {
        log.info("command", "command.user", `${light.name}: color ${toHex(latest.current)}`, {
          origin: "ui",
          light: { id: light.id, name: light.name },
          rgb: latest.current,
        });
        scheduleHistory(toHex(latest.current));
      }
    };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, [light.id, light.name]);

  return (
    <Panel
      color={shown}
      side={<ColorHistory colors={history} onPick={applyHistoryColor} />}
      action={<ResetButton light={light} />}
    >
      <div
        onPointerDown={() => {
          dragging.current = true;
          cancelPendingHistory();
        }}
        className="rounded-full ring-1 ring-border"
        style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
      >
        <Wheel
          aria-label={t("light.color_label", { name: light.name })}
          width={WHEEL_SIZE}
          height={WHEEL_SIZE}
          color={hsva}
          onChange={({ hsva: next }) => {
            const full = { ...next, v: 100, a: 1 };
            const rgb = toRgb(full);
            const xy = rgbToXy(rgb, light.gamut ?? undefined);
            latest.current = rgb;
            setPicked({ hsva: full, xy });
            void actions.setLight({ id: light.id, xy, on: true });
          }}
        />
      </div>
    </Panel>
  );
}

function WhiteOnly({ light }: { light: LightView }) {
  return (
    <Panel color={light.color}>
      <p className="max-w-32 text-xs text-muted-foreground">
        {t("light.white_only")}
        {light.mirek !== null && (
          <span className="mt-1 block font-medium text-foreground">
            {t("light.temperature_value", {
              kelvin: Math.round(1_000_000 / light.mirek / 100) * 100,
            })}
          </span>
        )}
      </p>
    </Panel>
  );
}

/** This light's recent colors, newest first. Picking one does not reorder the list. */
function ColorHistory({ colors, onPick }: { colors: string[]; onPick: (hex: string) => void }) {
  return (
    <div className="space-y-1.5 text-right">
      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t("light.history")}
      </p>
      {colors.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">{t("light.history_empty")}</p>
      ) : (
        <div className="flex flex-wrap justify-end gap-1.5">
          {colors.map((hex) => (
            <button
              key={hex}
              type="button"
              title={hex}
              aria-label={t("light.use_color", { hex })}
              onClick={() => onPick(hex)}
              className={cn(
                "size-6 rounded-full ring-1 ring-border transition-transform outline-none",
                "hover:scale-110 hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring",
              )}
              style={{ backgroundColor: toCss(hexToRgb(hex)) }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Left: the control. Right: extras (color history). Bottom: the color. */
/**
 * Back to white: the temperature slider slides in (see LightRow). Disabled
 * while the light already shows white, so the layout never jumps.
 */
function ResetButton({ light }: { light: LightView }) {
  const whiteMode = light.mirek !== null;

  const reset = () => {
    if (light.mirekRange) {
      const { min, max } = light.mirekRange;
      const mirek = Math.min(max, Math.max(min, DEFAULT_WHITE_MIREK));
      void actions.setLight({ id: light.id, mirek, on: true });
    } else {
      // Rare: a color light without color temperature - send white as xy.
      const xy = rgbToXy(mirekToRgb(DEFAULT_WHITE_MIREK), light.gamut ?? undefined);
      void actions.setLight({ id: light.id, xy, on: true });
    }
    log.info("command", "command.user", `${light.name}: reset to white`, {
      origin: "ui",
      light: { id: light.id, name: light.name },
    });
  };

  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={reset}
      disabled={whiteMode}
      aria-label={t("light.reset_label", { name: light.name })}
    >
      <RotateCcw />
      {t("light.reset")}
    </Button>
  );
}

/** Left: the control. Right: extras (color history). Bottom: the color, and an action. */
function Panel({
  color,
  side,
  action,
  children,
}: {
  color: Rgb | null;
  side?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1 space-y-2 rounded-md bg-muted/60 p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="shrink-0">{children}</div>
        {side && <div className="w-36 min-w-0">{side}</div>}
      </div>
      {(color || action) && (
        <div className="flex items-center justify-between gap-2">
          {color ? (
            <p
              data-selectable
              className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground"
            >
              <span
                className="size-3 shrink-0 rounded-full ring-1 ring-border"
                style={{ backgroundColor: toCss(color) }}
                aria-hidden
              />
              {t("light.rgb", { r: color.r, g: color.g, b: color.b })} · {toHex(color)}
            </p>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
    </div>
  );
}

function toRgb(hsva: HsvaColor): Rgb {
  const { r, g, b } = hsvaToRgba(hsva);
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}
