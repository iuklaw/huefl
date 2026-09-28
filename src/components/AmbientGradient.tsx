// A soft glow over the bottom half of the home view in the rooms' colors. It sits
// *behind* the content (the cards are opaque), so it tints the gaps and the
// space below the list without ever covering a control.
//
// Several rooms blend left to right in list order; rooms that are off drop
// out, and with everything off the glow fades away. Gradients cannot be
// transitioned in CSS, so changes cross-fade between two layers.

import { useEffect, useState } from "react";
import { toCss } from "@/lib/color";
import type { RoomView } from "@/types";

function backgroundFor(rooms: RoomView[]): string | null {
  const colors = rooms.filter((r) => r.on && r.color).map((r) => toCss(r.color!));
  if (colors.length === 0) return null;
  if (colors.length === 1) return colors[0]!;
  return `linear-gradient(to right, ${colors.join(", ")})`;
}

const FADE_UP = "linear-gradient(to top, black, transparent)";

export function AmbientGradient({ rooms }: { rooms: RoomView[] }) {
  const background = backgroundFor(rooms);
  const [layers, setLayers] = useState<[string | null, string | null]>([background, null]);
  const [front, setFront] = useState<0 | 1>(0);

  useEffect(() => {
    if (background === layers[front]) return;
    const back = front === 0 ? 1 : 0;
    setLayers((current) => {
      const next: [string | null, string | null] = [...current];
      next[back] = background;
      return next;
    });
    setFront(back);
    // Only a new color matters here; the layers are our own bookkeeping.
  }, [background]);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] opacity-25 dark:opacity-35"
      style={{ maskImage: FADE_UP, WebkitMaskImage: FADE_UP }}
    >
      {layers.map((layer, index) => (
        <div
          key={index}
          className="absolute inset-0 transition-opacity duration-700 ease-out"
          style={{ background: layer ?? "transparent", opacity: index === front && layer ? 1 : 0 }}
        />
      ))}
    </div>
  );
}
