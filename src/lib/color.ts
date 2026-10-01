// Color math for Hue lights: CIE xy <-> sRGB, color temperature -> RGB, and
// averaging several lights into one color.
//
// Hue lights take color as CIE 1931 xy, limited to a per-model gamut triangle
// (A: older LivingColors/Bloom, B: first-gen bulbs, C: current lights).
// Conversions follow Philips' published "RGB to xy" notes: wide-gamut D65
// matrices, sRGB gamma, and clamping to the gamut by the nearest point on the
// triangle. Brightness is separate on Hue (dimming), so every RGB here is at
// full brightness - the brightest channel is 255.

export type Xy = { x: number; y: number };
export type Rgb = { r: number; g: number; b: number };
export type Gamut = { red: Xy; green: Xy; blue: Xy };

export const GAMUT_C: Gamut = {
  red: { x: 0.6915, y: 0.3083 },
  green: { x: 0.17, y: 0.7 },
  blue: { x: 0.1532, y: 0.0475 },
};

/** Warm white used for lights that only dim (no color, no temperature). */
export const WARM_WHITE_MIREK = 370; // ≈ 2700 K

/** The white "Reset" returns a color light to - Hue's default power-on white. */
export const DEFAULT_WHITE_MIREK = 366; // ≈ 2700 K

const D65: Xy = { x: 0.3127, y: 0.329 };

// --- Gamut -------------------------------------------------------------------

function cross(a: Xy, b: Xy): number {
  return a.x * b.y - a.y * b.x;
}

function inGamut(p: Xy, g: Gamut): boolean {
  const v1 = { x: g.green.x - g.red.x, y: g.green.y - g.red.y };
  const v2 = { x: g.blue.x - g.red.x, y: g.blue.y - g.red.y };
  const q = { x: p.x - g.red.x, y: p.y - g.red.y };
  const s = cross(q, v2) / cross(v1, v2);
  const t = cross(v1, q) / cross(v1, v2);
  return s >= 0 && t >= 0 && s + t <= 1;
}

function closestOnSegment(a: Xy, b: Xy, p: Xy): Xy {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x ** 2 + ab.y ** 2)),
  );
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

/** The point itself if the light can show it, else the nearest one it can. */
export function clampToGamut(p: Xy, g: Gamut = GAMUT_C): Xy {
  if (inGamut(p, g)) return p;
  const candidates = [
    closestOnSegment(g.red, g.green, p),
    closestOnSegment(g.green, g.blue, p),
    closestOnSegment(g.blue, g.red, p),
  ];
  const distance = (c: Xy) => (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
  return candidates.reduce((best, c) => (distance(c) < distance(best) ? c : best));
}

// --- sRGB gamma --------------------------------------------------------------

function toLinear(channel: number): number {
  const v = channel / 255;
  return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
}

function fromLinear(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, c)) * 255);
}

/** Linear RGB scaled so the brightest channel is 1, then gamma-encoded. */
function linearToRgb(r: number, g: number, b: number): Rgb {
  const r0 = Math.max(0, r);
  const g0 = Math.max(0, g);
  const b0 = Math.max(0, b);
  const max = Math.max(r0, g0, b0);
  if (max === 0) return { r: 0, g: 0, b: 0 };
  return { r: fromLinear(r0 / max), g: fromLinear(g0 / max), b: fromLinear(b0 / max) };
}

// --- Conversions -------------------------------------------------------------

export function xyToRgb(xy: Xy, gamut: Gamut = GAMUT_C): Rgb {
  const p = clampToGamut(xy, gamut);
  if (p.y <= 0) return { r: 255, g: 255, b: 255 };
  const Y = 1;
  const X = (Y / p.y) * p.x;
  const Z = (Y / p.y) * (1 - p.x - p.y);
  return linearToRgb(
    X * 1.656492 - Y * 0.354851 - Z * 0.255038,
    -X * 0.707196 + Y * 1.655397 + Z * 0.036152,
    X * 0.051713 - Y * 0.121364 + Z * 1.01153,
  );
}

export function rgbToXy(rgb: Rgb, gamut: Gamut = GAMUT_C): Xy {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  const p = clampToGamut(sum === 0 ? D65 : { x: X / sum, y: Y / sum }, gamut);
  return { x: round4(p.x), y: round4(p.y) };
}

/** Color temperature (mireds) to RGB - Tanner Helland's blackbody fit. */
export function mirekToRgb(mirek: number): Rgb {
  const t = 1_000_000 / mirek / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(255, v)));
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

/**
 * Weighted average of colors, in linear light (averaging gamma-encoded values
 * makes mixes muddy and too dark), normalized back to full brightness.
 */
export function averageColor(colors: Rgb[], weights?: number[]): Rgb | null {
  if (colors.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  colors.forEach((c, i) => {
    const w = Math.max(weights?.[i] ?? 1, 0.0001);
    r += toLinear(c.r) * w;
    g += toLinear(c.g) * w;
    b += toLinear(c.b) * w;
    total += w;
  });
  return linearToRgb(r / total, g / total, b / total);
}

/** Color temperature (mireds) for a chromaticity - McCamy's CCT approximation.
 *  Used to give white-only lights the closest white to a palette color. */
export function xyToMirek({ x, y }: Xy): number {
  const n = (x - 0.332) / (0.1858 - y);
  const kelvin = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
  return Math.round(1_000_000 / Math.max(1000, Math.min(20000, kelvin)));
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** Plain Euclidean distance in sRGB - enough to tell "the same color again". */
export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

// --- Formatting --------------------------------------------------------------

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

export function toCss({ r, g, b }: Rgb, alpha = 1): string {
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

/**
 * The background glow while sync streams: how strongly the lights shine
 * (`level`, 0 off … 1 full - mean of each channel's brightest component) and
 * their colors at full brightness, so the hue stays visible when the lights
 * are dim - the strength is carried by `level`, not by darker colors.
 */
export function liveGlow(preview: readonly string[]): { colors: string[]; level: number } {
  if (preview.length === 0) return { colors: [], level: 0 };
  let total = 0;
  const colors = preview.map((hex) => {
    const rgb = hexToRgb(hex);
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    total += max / 255;
    if (max === 0) return "#000000";
    const scale = 255 / max;
    return toHex({
      r: Math.round(rgb.r * scale),
      g: Math.round(rgb.g * scale),
      b: Math.round(rgb.b * scale),
    });
  });
  return { colors, level: total / preview.length };
}

/**
 * Accent derived from a room's average color, readable in both themes: text
 * is mixed toward the foreground (pale colors vanish on white), the border
 * stays faint. Falls back to neutral tokens when the room has no color.
 */
export function accentStyles(color: Rgb | null): { text: string; border: string } {
  if (!color) return { text: "var(--muted-foreground)", border: "var(--border)" };
  const base = toCss(color);
  return {
    text: `color-mix(in oklch, ${base} 75%, var(--foreground))`,
    border: `color-mix(in oklch, ${base} 55%, transparent)`,
  };
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

// --- Palette from one color ----------------------------------------------------

/** HSL, hue in degrees, saturation and lightness 0–1. */
function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === rn ? 60 * (((gn - bn) / d) % 6) : max === gn ? 60 * ((bn - rn) / d + 2) : 60 * ((rn - gn) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v + m)) * 255);
  return { r: to(r), g: to(g), b: to(b) };
}

/** Lights show greys and very dark colors poorly: keep at least this much color. */
const MIN_SATURATION = 0.35;
const MIN_LIGHTNESS = 0.3;
const MAX_LIGHTNESS = 0.7;
/** Hue spread per light, and the most it may stray from the color. */
const HUE_STEP = 10;
const MAX_HUE_SPREAD = 40;
/** Neighbouring lights alternate a little lighter / darker. */
const LIGHTNESS_STEP = 0.08;

/**
 * `count` colors for a room's lights from one color (the "Color of the day"):
 * the color itself in the middle, analogous hues around it - spread ±10° per
 * light, at most ±40° - with lightness alternating slightly so neighbours
 * differ while the whole stays one mood. Too grey or too dark a color keeps
 * its hue but gets enough saturation and light for a lamp to show it.
 */
export function paletteFromColor(hex: string, count: number): string[] {
  const n = Math.max(1, Math.floor(count));
  const base = rgbToHsl(hexToRgb(hex));
  const s = Math.max(base.s, MIN_SATURATION);
  const l = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, base.l));
  const spread = Math.min(MAX_HUE_SPREAD, HUE_STEP * n);
  const middle = Math.floor((n - 1) / 2);
  return Array.from({ length: n }, (_, i) => {
    const offset = n === 1 ? 0 : -spread + (2 * spread * i) / (n - 1);
    // The middle light gets the color of the day itself (adjusted for lamps).
    const h = i === middle && n % 2 === 1 ? base.h : (base.h + offset + 360) % 360;
    const shade = i === middle ? 0 : (i % 2 === 0 ? 1 : -1) * LIGHTNESS_STEP;
    return toHex(hslToRgb({ h, s, l: Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, l + shade)) }));
  });
}

/** Hue in degrees of a hex color (for tests and callers that compare hues). */
export function hueOf(hex: string): number {
  return rgbToHsl(hexToRgb(hex)).h;
}
