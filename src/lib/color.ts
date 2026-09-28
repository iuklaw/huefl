// Color math for Hue lights: CIE xy <-> sRGB, color temperature -> RGB, and
// averaging several lights into one color.
//
// Hue lights take color as CIE 1931 xy, limited to a per-model gamut triangle
// (A: older LivingColors/Bloom, B: first-gen bulbs, C: current lights).
// Conversions follow Philips' published "RGB to xy" notes: wide-gamut D65
// matrices, sRGB gamma, and clamping to the gamut by the nearest point on the
// triangle. Brightness is separate on Hue (dimming), so every RGB here is at
// full brightness — the brightest channel is 255.

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

/** The white "Reset" returns a color light to — Hue's default power-on white. */
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
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x ** 2 + ab.y ** 2)));
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

/** Color temperature (mireds) to RGB — Tanner Helland's blackbody fit. */
export function mirekToRgb(mirek: number): Rgb {
  const t = 1_000_000 / mirek / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
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

/** Color temperature (mireds) for a chromaticity — McCamy's CCT approximation.
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

/** Plain Euclidean distance in sRGB — enough to tell "the same color again". */
export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

// --- Formatting --------------------------------------------------------------

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function toCss({ r, g, b }: Rgb, alpha = 1): string {
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
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
