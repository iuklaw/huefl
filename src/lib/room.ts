// The room of the layout editor: a fixed-angle isometric view, like the
// Philips Hue app's light placement.
//
// Hue positions are relative, -1..1 on each axis: x left -> right, y from the
// viewer (-1) to the screen (1), z floor (-1) -> ceiling (1). On screen, x
// runs down-right and y up-right at 30°, z straight up - so the screen's
// wall (y = 1) is the back-right wall, and the viewer sits front-left.
//
// Pure: projection, its inverse for dragging, the furniture's faces, and the
// colors the lights show while being placed.

import type { Position3 } from "@/types";

export type LayoutMode = "location" | "height";

/** Half the floor's side, and the walls' height, in SVG units. */
const S = 100;
const WALL = 120;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;
const MARGIN = 10;

/** x, y, width, height - the room with a little air around it. */
export const VIEWBOX = [
  -2 * S * COS30 - MARGIN,
  -S - WALL - MARGIN,
  4 * S * COS30 + 2 * MARGIN,
  2 * S + WALL + 2 * MARGIN,
] as const;

export type Point = { sx: number; sy: number };

function clamp(n: number, min = -1, max = 1): number {
  return Math.min(max, Math.max(min, n));
}

/** How far above the floor height z is drawn. */
function lift(z: number): number {
  return ((z + 1) / 2) * WALL;
}

export function project({ x, y, z }: Position3): Point {
  return { sx: S * COS30 * (x + y), sy: S * SIN30 * (x - y) - lift(z) };
}

/** Location: where on the floor a point drawn at (sx, sy) is, for a light at height z. */
export function floorAt(sx: number, sy: number, z: number): { x: number; y: number } {
  const sum = sx / (S * COS30); // x + y
  const diff = (sy + lift(z)) / (S * SIN30); // x - y
  return { x: clamp((sum + diff) / 2), y: clamp((sum - diff) / 2) };
}

/** Height: how high a light standing at (x, y) is when drawn at sy. */
export function heightAt(sy: number, { x, y }: { x: number; y: number }): number {
  const floor = S * SIN30 * (x - y);
  return clamp((2 * (floor - sy)) / WALL - 1);
}

/** SVG points of a polygon through the given positions. */
export function polygon(corners: Position3[]): string {
  return corners
    .map(project)
    .map(({ sx, sy }) => `${sx.toFixed(1)},${sy.toFixed(1)}`)
    .join(" ");
}

export const FLOOR = polygon([
  { x: -1, y: -1, z: -1 },
  { x: 1, y: -1, z: -1 },
  { x: 1, y: 1, z: -1 },
  { x: -1, y: 1, z: -1 },
]);
export const LEFT_WALL = polygon([
  { x: -1, y: -1, z: -1 },
  { x: -1, y: 1, z: -1 },
  { x: -1, y: 1, z: 1 },
  { x: -1, y: -1, z: 1 },
]);
/** The wall the screen hangs on (y = 1). */
export const SCREEN_WALL = polygon([
  { x: -1, y: 1, z: -1 },
  { x: 1, y: 1, z: -1 },
  { x: 1, y: 1, z: 1 },
  { x: -1, y: 1, z: 1 },
]);

/** The three faces of a box the viewer sees: top, the side facing +x, the side facing -y. */
export function box(
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
  [z0, z1]: [number, number],
): { top: string; right: string; front: string } {
  return {
    top: polygon([
      { x: x0, y: y0, z: z1 },
      { x: x1, y: y0, z: z1 },
      { x: x1, y: y1, z: z1 },
      { x: x0, y: y1, z: z1 },
    ]),
    right: polygon([
      { x: x1, y: y0, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: x1, y: y1, z: z1 },
      { x: x1, y: y0, z: z1 },
    ]),
    front: polygon([
      { x: x0, y: y0, z: z0 },
      { x: x1, y: y0, z: z0 },
      { x: x1, y: y0, z: z1 },
      { x: x0, y: y0, z: z1 },
    ]),
  };
}

/**
 * The color a light shows while being placed - on its dot, its card and the
 * real light, so moving one tells which bulb it is. Location: the hue goes
 * round the room, paler toward the middle. Height: pink at the floor, blue
 * at the ceiling.
 */
export function positionColor({ x, y, z }: Position3, mode: LayoutMode): string {
  if (mode === "height") return hslHex(330 - ((clamp(z) + 1) / 2) * 120, 0.85, 0.62);
  const angle = (Math.atan2(y, x) * 180) / Math.PI;
  const reach = Math.min(1, Math.hypot(x, y) / Math.SQRT2);
  return hslHex((angle + 360) % 360, 0.5 + 0.45 * reach, 0.62);
}

/** Light ids, farthest from the viewer first - nearer ones are drawn on top. */
export function depthOrder(positions: Map<string, Position3>): string[] {
  return [...positions.keys()].sort((a, b) => {
    const pa = positions.get(a)!;
    const pb = positions.get(b)!;
    return pa.x - pa.y - (pb.x - pb.y) || pa.z - pb.z;
  });
}

function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}
