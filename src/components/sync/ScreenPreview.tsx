// Screen preview for screen sync: the coarse color grid Rust samples the
// screen into (zones::Grid, 32 × 18 cells), drawn as a soft miniature, with
// a marker where each light looks and the color it shows.
//
// Drawn as a monitor — bezel, chin, stand — in CSS, so it follows the
// monitor's proportions and stays sharp at any size.
//
// Only the averaged cells ever reach the window — never the picture itself.
// The grid arrives as "sync-screen" ~10× a second and is painted straight
// onto the canvas, without React re-rendering.

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { averageColor, hexToRgb, toCss } from "@/lib/color";
import type { Position3 } from "@/types";

type Grid = { cols: number; rows: number; cells: number[] };

/** A light's view, as in src-tauri/src/sync/screen/zones.rs (SIGMA_X/Y × ZoneStyle.focus). */
const SIGMA = { x: 0.18, y: 0.35 };
const FOCUS = [1.2, 1.0, 0.8, 0.6];
const SCREEN_HEIGHT = 112;
const MAX_WIDTH = 320;

/** Where a light looks: x → left…right, height z → top…bottom (zones::watch_point). */
function watchPoint({ x, z }: Position3): { u: number; v: number } {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return { u: clamp((x + 1) / 2), v: clamp(1 - (z + 1) / 2) };
}

type Props = {
  /** The area's channels, in channel order. */
  channels: { channelId: number; position: Position3 }[];
  /** Current light colors, "#RRGGBB", in channel order. */
  colors: string[];
  intensity: number;
  /** Width / height of the captured monitor. */
  aspect: number;
};

export function ScreenPreview({ channels, colors, intensity, aspect }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const unlisten = listen<Grid>("sync-screen", ({ payload: { cols, rows, cells } }) => {
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!el || !ctx) return;
      if (el.width !== cols || el.height !== rows) Object.assign(el, { width: cols, height: rows });
      const image = ctx.createImageData(cols, rows);
      for (let i = 0; i < cols * rows; i++) {
        image.data.set([cells[i * 3]!, cells[i * 3 + 1]!, cells[i * 3 + 2]!, 255], i * 4);
      }
      ctx.putImageData(image, 0, 0);
    });
    return () => void unlisten.then((stop) => stop());
  }, []);

  const focus = FOCUS[Math.min(3, Math.max(0, intensity))]!;
  // The screen lights up its surroundings a little, like in a dark room.
  const average = averageColor(colors.map(hexToRgb));
  const glow = average ? `0 0 28px -6px ${toCss(average, 0.8)}` : "none";
  // Ultra-wide monitors get narrower instead of overflowing; the stand is
  // sized from the screen's width.
  const width = Math.min(SCREEN_HEIGHT * aspect, MAX_WIDTH);
  const height = width / aspect;

  return (
    <div className="flex flex-col items-center px-3 pb-2" aria-hidden>
      {/* Case: thin bezel on the sides and top, a chin below. */}
      <div
        className="rounded-lg border border-black/10 bg-zinc-800 px-1 pt-1 transition-shadow duration-300 dark:border-white/10 dark:bg-zinc-900"
        style={{ boxShadow: glow }}
      >
        <div
          className="relative overflow-hidden rounded-sm bg-black"
          style={{ height, width }}
        >
          {/* 32 × 18 pixels, stretched: the browser's smoothing blurs the cells
              into a soft picture. */}
          <canvas ref={canvas} width={32} height={18} className="absolute inset-0 size-full" />

          {channels.map((channel, i) => {
            const { u, v } = watchPoint(channel.position);
            const color = colors[i] ?? "#000000";
            const at = { left: `${u * 100}%`, top: `${v * 100}%` };
            return (
              <div key={channel.channelId}>
                {/* The part of the screen this light follows. */}
                <div
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border opacity-60"
                  style={{
                    ...at,
                    width: `${SIGMA.x * focus * 200}%`,
                    height: `${SIGMA.y * focus * 200}%`,
                    borderColor: color,
                  }}
                />
                {/* The light, in the color it shows now. */}
                <div
                  className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white/80 transition-colors duration-100"
                  style={{ ...at, backgroundColor: color, boxShadow: `0 0 10px ${color}` }}
                />
              </div>
            );
          })}
        </div>
        {/* Chin with the power light. */}
        <div className="flex h-2 items-center justify-center">
          <span className="size-1 rounded-full bg-primary shadow-[0_0_4px_var(--color-primary)]" />
        </div>
      </div>
      {/* Stand: a tapered neck on a flat foot. */}
      <div
        className="h-3.5 bg-gradient-to-b from-zinc-700 to-zinc-800 dark:from-zinc-800 dark:to-zinc-900"
        style={{ width: width * 0.14, clipPath: "polygon(22% 0, 78% 0, 100% 100%, 0 100%)" }}
      />
      <div
        className="h-1.5 rounded-full border border-black/10 bg-zinc-800 shadow-sm dark:border-white/10 dark:bg-zinc-900"
        style={{ width: width * 0.38 }}
      />
    </div>
  );
}
