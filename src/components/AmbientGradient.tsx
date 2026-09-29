// A soft glow behind the main views (Lights and Sync), fading upward. It sits
// *behind* the content (the cards are opaque), so it tints the gaps and the
// space below the list without ever covering a control.
//
// Calm: the rooms' colors over the bottom half, left to right in list order;
// rooms that are off drop out, and with everything off the glow fades away.
// Gradients cannot be transitioned in CSS, so changes cross-fade between two
// layers.
//
// Live (while sync streams): the lights' current colors, with height and
// strength following how brightly they shine — loud music reaches the top,
// silence sinks to nothing. Updates ~12×/s, so a single layer is used; a slow
// cross-fade would blur the rhythm. With reduced motion the height stays put
// and only the strength follows.

import { useEffect, useState } from "react";
import { toCss } from "@/lib/color";
import type { RoomView } from "@/types";

export type LiveGlow = { colors: string[]; level: number };

function backgroundFor(colors: string[]): string | null {
  if (colors.length === 0) return null;
  if (colors.length === 1) return colors[0]!;
  return `linear-gradient(to right, ${colors.join(", ")})`;
}

const FADE_UP = "linear-gradient(to top, black, transparent)";
const CALM_HEIGHT = "55%";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function AmbientGradient({ rooms, live }: { rooms: RoomView[]; live?: LiveGlow | null }) {
  const calm = backgroundFor(rooms.filter((r) => r.on && r.color).map((r) => toCss(r.color!)));
  const [layers, setLayers] = useState<[string | null, string | null]>([calm, null]);
  const [front, setFront] = useState<0 | 1>(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (calm === layers[front]) return;
    const back = front === 0 ? 1 : 0;
    setLayers((current) => {
      const next: [string | null, string | null] = [...current];
      next[back] = calm;
      return next;
    });
    setFront(back);
    // Only a new color matters here; the layers are our own bookkeeping.
  }, [calm]);

  const level = live ? Math.min(1, Math.max(0, live.level)) : 0;

  return (
    <>
      {/* Calm layer: always there, faded out while live, so starting and
          stopping sync cross-fade instead of jumping. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 transition-opacity duration-700"
        style={{
          height: CALM_HEIGHT,
          maskImage: FADE_UP,
          WebkitMaskImage: FADE_UP,
          opacity: live ? 0 : 1,
        }}
      >
        <div className="absolute inset-0 opacity-25 dark:opacity-35">
          {layers.map((layer, index) => (
            <div
              key={index}
              className="absolute inset-0 transition-opacity duration-700 ease-out"
              style={{
                background: layer ?? "transparent",
                opacity: index === front && layer ? 1 : 0,
              }}
            />
          ))}
        </div>
      </div>

      {live && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 transition-[height,opacity] duration-120 ease-linear"
          style={{
            height: reducedMotion ? CALM_HEIGHT : `${Math.round(level * 100)}%`,
            // Stronger than the calm glow, still leaving text readable.
            opacity: 0.15 + 0.5 * level,
            background: backgroundFor(live.colors) ?? "transparent",
            maskImage: FADE_UP,
            WebkitMaskImage: FADE_UP,
          }}
        />
      )}
    </>
  );
}
