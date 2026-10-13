// Where the lights of a sync area stand, placed in a small isometric room -
// like the Philips Hue app's light placement. The screen hangs on the
// back-right wall (a TV, or a monitor on a desk); the viewer sits front-left.
//
// Location drags a light across the floor, Height raises or lowers it. While
// placing, each light shows a color from where it stands - on its dot, its
// card and the real light - so moving one tells which bulb it is. The lights
// go back to how they were when the editor closes.

import { useEffect, useMemo, useRef, useState } from "react";
import { Segmented } from "@/components/Segmented";
import { actions } from "@/core/app";
import { t } from "@/i18n";
import {
  box,
  depthOrder,
  floorAt,
  FLOOR,
  heightAt,
  LEFT_WALL,
  polygon,
  positionColor,
  project,
  SCREEN_WALL,
  VIEWBOX,
  type LayoutMode,
} from "@/lib/room";
import { cn } from "@/lib/utils";
import type { AreaDraft, LightView, Position3 } from "@/types";

type Props = {
  kind: AreaDraft["kind"];
  lights: LightView[];
  positions: Map<string, Position3>;
  onMove: (lightId: string, position: Position3) => void;
};

/** Arrow keys move the chosen light this far. */
const STEP = 0.05;

export function LayoutRoom({ kind, lights, positions, onMove }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [mode, setMode] = useState<LayoutMode>("location");
  const [selected, setSelected] = useState<string | null>(lights[0]?.id ?? null);
  /** The light being dragged, and where on its dot it was grabbed. */
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const colors = useMemo(
    () =>
      Object.fromEntries(
        lights.map((l) => [l.id, positionColor(positions.get(l.id)!, mode)] as const),
      ),
    [lights, positions, mode],
  );

  // The real lights: their place's colors while the editor is open, then back
  // as they were. Later changes only send what changed.
  const sent = useRef<Record<string, string>>({});
  const ids = lights.map((l) => l.id).join(",");
  useEffect(() => {
    sent.current = { ...colors };
    return actions.showLightColors(colors);
    // Once per set of lights; colors that change later are sent below.
  }, [ids]);
  useEffect(() => {
    const changed = Object.fromEntries(
      Object.entries(colors).filter(([id, hex]) => sent.current[id] !== hex),
    );
    if (Object.keys(changed).length === 0) return;
    sent.current = { ...sent.current, ...changed };
    actions.paintLights(changed);
  }, [colors]);

  const toSvg = (event: React.PointerEvent) => {
    const el = svg.current;
    const matrix = el?.getScreenCTM();
    if (!el || !matrix) return null;
    const point = el.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(matrix.inverse());
  };

  const grab = (event: React.PointerEvent, id: string) => {
    setSelected(id);
    const at = toSvg(event);
    if (!at) return;
    const dot = project(positions.get(id)!);
    drag.current = { id, dx: at.x - dot.sx, dy: at.y - dot.sy };
    svg.current!.setPointerCapture(event.pointerId);
  };

  const follow = (event: React.PointerEvent) => {
    const d = drag.current;
    const at = d && toSvg(event);
    if (!d || !at) return;
    const p = positions.get(d.id)!;
    const sx = at.x - d.dx;
    const sy = at.y - d.dy;
    const next = mode === "location" ? { ...floorAt(sx, sy, p.z), z: p.z } : { ...p, z: heightAt(sy, p) };
    onMove(d.id, round(next));
  };

  const nudge = (event: React.KeyboardEvent) => {
    const p = selected ? positions.get(selected) : undefined;
    if (!selected || !p) return;
    const height = mode === "height";
    const delta: Partial<Record<string, Partial<Position3>>> = {
      ArrowLeft: height ? {} : { x: -STEP },
      ArrowRight: height ? {} : { x: STEP },
      ArrowUp: height ? { z: STEP } : { y: STEP },
      ArrowDown: height ? { z: -STEP } : { y: -STEP },
      PageUp: { z: STEP },
      PageDown: { z: -STEP },
    };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    onMove(selected, round({ x: p.x + (d.x ?? 0), y: p.y + (d.y ?? 0), z: p.z + (d.z ?? 0) }));
  };

  const order = depthOrder(positions);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" onKeyDown={nudge}>
      <Segmented
        options={(["location", "height"] as const).map((m) => ({
          value: m,
          label: t(`sync.area.layout_mode.${m}`),
        }))}
        value={mode}
        onChange={setMode}
      />

      <svg
        ref={svg}
        viewBox={VIEWBOX.join(" ")}
        className="min-h-0 w-full flex-1 touch-none select-none"
        onPointerMove={follow}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        role="img"
        aria-label={t("sync.area.layout_label")}
      >
        <polygon points={LEFT_WALL} className="fill-foreground/6" />
        <polygon points={SCREEN_WALL} className="fill-foreground/10" />
        <polygon points={FLOOR} className="fill-foreground/14" />
        <Furniture kind={kind} />

        {order.map((id) => {
          const p = positions.get(id)!;
          const floor = project({ ...p, z: -1 });
          const dot = project(p);
          const color = colors[id]!;
          const name = lights.find((l) => l.id === id)?.name;
          return (
            <g key={id}>
              <ellipse cx={floor.sx} cy={floor.sy} rx={7} ry={3.5} className="fill-foreground/25" />
              <line
                x1={floor.sx}
                y1={floor.sy}
                x2={dot.sx}
                y2={dot.sy}
                strokeWidth={2}
                className="stroke-foreground/40"
              />
              {selected === id && (
                <circle cx={dot.sx} cy={dot.sy} r={11.5} fill="none" strokeWidth={2} className="stroke-foreground" />
              )}
              <circle
                cx={dot.sx}
                cy={dot.sy}
                r={8}
                fill={color}
                stroke="white"
                strokeWidth={2}
                className="cursor-grab active:cursor-grabbing"
                style={{ filter: `drop-shadow(0 0 4px ${color})` }}
                onPointerDown={(e) => grab(e, id)}
              >
                <title>{name}</title>
              </circle>
            </g>
          );
        })}
      </svg>

      <p className="text-center text-[11px] text-muted-foreground">
        {mode === "location" ? t("sync.area.layout_hint") : t("sync.area.height_hint")}
        {kind === "music" && mode === "location" && ` ${t("sync.area.layout_hint_music")}`}
      </p>

      <div className="-mx-1 flex gap-2 overflow-x-auto p-1">
        {lights.map((light) => {
          const color = colors[light.id]!;
          return (
            <button
              key={light.id}
              type="button"
              onClick={() => setSelected(light.id)}
              aria-pressed={selected === light.id}
              className={cn(
                "flex h-11 max-w-32 min-w-20 shrink-0 items-center justify-center rounded-xl border-2 px-3 transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring",
                selected === light.id && "ring-2 ring-foreground ring-offset-2 ring-offset-popover",
              )}
              style={{ borderColor: color }}
            >
              <span className="truncate text-xs font-medium">{light.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** What stands in the room: a TV on its stand, or a monitor on a desk, and a sofa facing the screen. */
function Furniture({ kind }: { kind: AreaDraft["kind"] }) {
  return (
    <g aria-hidden>
      {kind === "screen" && (
        <>
          <Box x={[-0.6, 0.6]} y={[0.78, 1]} z={[-1, -0.72]} />
          <polygon
            points={polygon([
              { x: -0.5, y: 0.99, z: -0.66 },
              { x: 0.5, y: 0.99, z: -0.66 },
              { x: 0.5, y: 0.99, z: 0.64 },
              { x: -0.5, y: 0.99, z: 0.64 },
            ])}
            className="fill-zinc-900 stroke-zinc-600 dark:stroke-zinc-500"
            strokeWidth={1.5}
          />
        </>
      )}
      {kind === "monitor" && (
        <>
          <Box x={[-0.55, 0.55]} y={[0.45, 0.95]} z={[-1, -0.42]} />
          <Box x={[-0.04, 0.04]} y={[0.78, 0.84]} z={[-0.42, -0.3]} />
          <polygon
            points={polygon([
              { x: -0.32, y: 0.78, z: -0.34 },
              { x: 0.32, y: 0.78, z: -0.34 },
              { x: 0.32, y: 0.78, z: 0.4 },
              { x: -0.32, y: 0.78, z: 0.4 },
            ])}
            className="fill-zinc-900 stroke-zinc-600 dark:stroke-zinc-500"
            strokeWidth={1.5}
          />
        </>
      )}
      <Box x={[-0.55, 0.55]} y={[-0.92, -0.5]} z={[-1, -0.72]} />
      <Box x={[-0.55, 0.55]} y={[-0.92, -0.78]} z={[-0.72, -0.42]} />
    </g>
  );
}

function Box({ x, y, z }: { x: [number, number]; y: [number, number]; z: [number, number] }) {
  const faces = box(x, y, z);
  return (
    <>
      <polygon points={faces.front} className="fill-foreground/20" />
      <polygon points={faces.right} className="fill-foreground/30" />
      <polygon points={faces.top} className="fill-foreground/42" />
    </>
  );
}

function round({ x, y, z }: Position3): Position3 {
  const r = (v: number) => Math.round(Math.min(1, Math.max(-1, v)) * 100) / 100;
  return { x: r(x), y: r(y), z: r(z) };
}
