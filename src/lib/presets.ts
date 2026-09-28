// Pure logic behind color history, saved scenes and popular palettes: what to
// store and which commands to send. No I/O here — core/app.ts does that.
//
// Every command respects what a light can do (see LightView.capabilities):
// color lights get xy clamped to their own gamut, white-ambiance lights get the
// closest white temperature, dim-only lights get brightness, plugs only on/off.

import {
  colorDistance,
  hexToRgb,
  mirekToRgb,
  rgbToXy,
  toCss,
  toHex,
  xyToMirek,
  xyToRgb,
  type Rgb,
} from "@/lib/color";
import type { LightCommand, LightView, Palette, Scene, SceneLightState } from "@/types";

export const HISTORY_SIZE = 5;
/** Colors closer than this (sRGB distance) count as the same history entry. */
export const SAME_COLOR_DISTANCE = 24;

// --- Color history -----------------------------------------------------------

/** Newest first; a near-duplicate moves to the front instead of repeating. */
export function pushHistory(history: readonly string[], hex: string): string[] {
  const rgb = hexToRgb(hex);
  const rest = history.filter((h) => colorDistance(hexToRgb(h), rgb) >= SAME_COLOR_DISTANCE);
  return [hex.toUpperCase(), ...rest].slice(0, HISTORY_SIZE);
}

// --- Scenes ------------------------------------------------------------------

/** The current state of the given lights, in the form a scene stores. */
export function captureScene(lights: readonly LightView[]): Record<string, SceneLightState> {
  const states: Record<string, SceneLightState> = {};
  for (const light of lights) {
    const state: SceneLightState = { on: light.on };
    if (light.capabilities.dimming) state.brightness = light.brightness;
    // A light is in one mode at a time: temperature when mirek is set, else xy.
    if (light.mirek !== null) state.mirek = light.mirek;
    else if (light.capabilities.color && light.xy) state.xy = light.xy;
    states[light.id] = state;
  }
  return states;
}

/** Commands restoring a scene; lights added to the room since are left alone. */
export function sceneCommands(scene: Scene, lights: readonly LightView[]): LightCommand[] {
  const commands: LightCommand[] = [];
  for (const light of lights) {
    const state = scene.lights[light.id];
    if (!state) continue;
    const command: LightCommand = { id: light.id, on: state.on };
    if (state.on) {
      if (state.brightness !== undefined && light.capabilities.dimming) {
        command.brightness = state.brightness;
      }
      if (state.xy && light.capabilities.color) command.xy = state.xy;
      else if (state.mirek !== undefined && light.capabilities.temperature) {
        command.mirek = clampMirek(state.mirek, light);
      }
    }
    commands.push(command);
  }
  return commands;
}

/** Up to `max` colors a scene shows, for its preview dots. */
export function scenePreview(scene: Scene, max = 5): Rgb[] {
  return Object.values(scene.lights)
    .filter((s) => s.on && (s.xy || s.mirek !== undefined))
    .slice(0, max)
    .map((s) => (s.xy ? xyToRgb(s.xy) : mirekToRgb(s.mirek!)));
}

// --- Palettes ----------------------------------------------------------------

/**
 * Commands applying a palette to a room: colors are dealt out to the lights in
 * name order (so the result is repeatable), cycling when there are more lights
 * than colors. Every light is turned on.
 */
export function paletteCommands(palette: Palette, lights: readonly LightView[]): LightCommand[] {
  const ordered = [...lights].sort((a, b) => a.name.localeCompare(b.name));
  return ordered.map((light, index) => {
    const command: LightCommand = { id: light.id, on: true };
    if (light.capabilities.dimming) command.brightness = palette.brightness;

    if (palette.mirek !== undefined) {
      if (light.capabilities.temperature) command.mirek = clampMirek(palette.mirek, light);
      return command;
    }

    const colors = palette.colors ?? [];
    if (colors.length === 0) return command;
    const rgb = hexToRgb(colors[index % colors.length]!);
    if (light.capabilities.color) {
      command.xy = rgbToXy(rgb, light.gamut ?? undefined);
    } else if (light.capabilities.temperature) {
      command.mirek = clampMirek(xyToMirek(rgbToXy(rgb)), light);
    }
    return command;
  });
}

/** CSS background for a palette's preview strip. */
export function paletteBackground(palette: Palette): string {
  if (palette.mirek !== undefined) return toCss(mirekToRgb(palette.mirek));
  const colors = palette.colors ?? [];
  return colors.length === 1 ? colors[0]! : `linear-gradient(to right, ${colors.join(", ")})`;
}

function clampMirek(mirek: number, light: LightView): number {
  const range = light.mirekRange;
  return range ? Math.min(range.max, Math.max(range.min, Math.round(mirek))) : Math.round(mirek);
}

// --- Active preset -----------------------------------------------------------
//
// The "current" preset is derived from what the lights actually show, not
// remembered as "last clicked": change one light and it is no longer current;
// get back to the look (here, via the Philips app, after a restart) and it is
// again. A preset is current when its commands would change nothing.

/** Tolerances for bridge rounding (brightness 60 → 59.84, xy re-gamuted). */
export const MATCH_XY = 0.01;
export const MATCH_BRIGHTNESS = 2;
export const MATCH_MIREK = 3;

export type ActivePreset = { kind: "scene" | "palette"; id: string };

/** Whether a light already is where `command` would take it. */
function matches(command: LightCommand, light: LightView): boolean {
  if (command.on !== undefined && command.on !== light.on) return false;
  if (!light.on) return true;
  if (
    command.brightness !== undefined &&
    light.capabilities.dimming &&
    Math.abs(light.brightness - command.brightness) > MATCH_BRIGHTNESS
  ) {
    return false;
  }
  if (command.xy) {
    // In white mode the bridge's xy is stale — a color scene cannot match.
    if (light.mirek !== null || !light.xy) return false;
    if (Math.abs(light.xy.x - command.xy.x) > MATCH_XY) return false;
    if (Math.abs(light.xy.y - command.xy.y) > MATCH_XY) return false;
  }
  if (command.mirek !== undefined) {
    if (light.mirek === null || Math.abs(light.mirek - command.mirek) > MATCH_MIREK) return false;
  }
  return true;
}

function allMatch(commands: LightCommand[], lights: readonly LightView[]): boolean {
  const byId = new Map(lights.map((l) => [l.id, l]));
  return commands.every((command) => {
    const light = byId.get(command.id);
    return light !== undefined && matches(command, light);
  });
}

/**
 * The preset the room's lights currently show. Saved scenes are checked first
 * (newest first), so the user's own preset wins over an identical palette.
 */
export function findActivePreset(
  lights: readonly LightView[],
  scenes: readonly Scene[],
  palettes: readonly Palette[],
): ActivePreset | null {
  if (lights.length === 0) return null;

  for (const scene of scenes) {
    const commands = sceneCommands(scene, lights);
    if (commands.length > 0 && allMatch(commands, lights)) return { kind: "scene", id: scene.id };
  }

  for (const palette of palettes) {
    const commands = paletteCommands(palette, lights);
    // A palette has to define some color or white; brightness alone (a room of
    // dim-only lights) would make every palette "match".
    const defining = commands.some((c) => c.xy || c.mirek !== undefined);
    if (defining && allMatch(commands, lights)) return { kind: "palette", id: palette.id };
  }

  return null;
}

/** A palette's colors as "#RRGGBB" — what the sync engine takes. */
export function paletteHex(palette: Palette): string[] {
  if (palette.mirek !== undefined) return [toHex(mirekToRgb(palette.mirek))];
  return palette.colors ?? [];
}
