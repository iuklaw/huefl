// Spectrum bars for music sync. The analysis runs in Rust (the audio is
// captured there, and it keeps going with the window hidden); this only draws
// what "sync-spectrum" reports ~25× a second: one 0–255 value per bar,
// low to high frequencies.
//
// Updates go straight to the bars' styles, not through React state, so the
// Sync tab doesn't re-render 25 times a second.

import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { hexToRgb, toCss } from "@/lib/color";

const BARS = 24; // SPECTRUM_BANDS in src-tauri/src/sync/audio/analyzer.rs

/** The palette spread left to right over the bars, like on the lights. */
function barColors(palette: string[]): string[] {
  const stops = (palette.length > 0 ? palette : ["#FFFFFF"]).map(hexToRgb);
  return Array.from({ length: BARS }, (_, i) => {
    const at = stops.length === 1 ? 0 : (i / (BARS - 1)) * (stops.length - 1);
    const k = Math.min(Math.floor(at), stops.length - 2);
    if (k < 0) return toCss(stops[0]!);
    const t = at - k;
    const [a, b] = [stops[k]!, stops[k + 1]!];
    const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
    return toCss({ r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b) });
  });
}

export function SpectrumBars({ colors }: { colors: string[] }) {
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const fills = useMemo(() => barColors(colors), [colors]);

  useEffect(() => {
    const unlisten = listen<number[]>("sync-spectrum", ({ payload }) => {
      payload.forEach((value, i) => {
        const bar = bars.current[i];
        if (bar) bar.style.transform = `scaleY(${value / 255})`;
      });
    });
    return () => void unlisten.then((stop) => stop());
  }, []);

  return (
    <div className="flex h-12 items-end gap-0.5 px-3" aria-hidden>
      {fills.map((fill, i) => (
        <div
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="h-full flex-1 origin-bottom rounded-t-sm transition-transform duration-75 ease-linear"
          style={{ backgroundColor: fill, transform: "scaleY(0)" }}
        />
      ))}
    </div>
  );
}
