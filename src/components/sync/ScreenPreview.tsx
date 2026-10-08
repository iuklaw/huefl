// Screen preview for screen sync: the coarse color grid Rust samples the
// screen into (zones::Grid, 32 × 18 cells), drawn as a soft miniature that
// glows with the lights' colors.
//
// Drawn as a monitor - bezel, chin, stand - in CSS, so it follows the
// monitor's proportions and stays sharp at any size.
//
// Only the averaged cells ever reach the window - never the picture itself.
// The grid arrives as "sync-screen" ~10× a second and is painted straight
// onto the canvas, without React re-rendering.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { averageColor, hexToRgb, toCss } from "@/lib/color";

type Grid = { cols: number; rows: number; cells: number[]; aspect: number };

const SCREEN_HEIGHT = 112;
const MAX_WIDTH = 320;

type Props = {
  /** Current light colors, "#RRGGBB" - for the glow around the screen. */
  colors: string[];
  /** Width / height of the captured monitor, until the stream says (Wayland). */
  aspect: number;
};

export function ScreenPreview({ colors, aspect: initialAspect }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The captured picture's own proportions, once frames arrive.
  const [streamAspect, setStreamAspect] = useState<number | null>(null);
  const aspect = streamAspect ?? initialAspect;

  useEffect(() => {
    const unlisten = listen<Grid>("sync-screen", ({ payload: { cols, rows, cells, aspect: frameAspect } }) => {
      if (frameAspect > 0) setStreamAspect((current) => (current !== null && Math.abs(current - frameAspect) < 0.01 ? current : frameAspect));
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
