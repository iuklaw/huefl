// Where the sun is watched from: a world map (offline, equirectangular) with
// 15° time zone bands, the day/night line of this moment, and a pin to click
// or drag. Also a search over the tz database's cities.

import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { scheduleLocation, schedules, useSchedules } from "@/core/schedules";
import { log } from "@/core/log";
import { t } from "@/i18n";
import { WORLD_LAND } from "@/lib/world-land";
import { zoneOffset } from "@/lib/time";
import { cn } from "@/lib/utils";
import { locationAt, searchPlaces, zoneLocation } from "@/lib/zones";
import type { ScheduleLocation } from "@/types";

// The map shows latitudes 84° N … 60° S (Antarctica is mostly in the way).
const NORTH = 84;
const SOUTH = -60;
const VIEW = `0 ${90 - NORTH} 360 ${NORTH - SOUTH}`;

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

export function LocationDialog({ open, onOpenChange }: Props) {
  const { timeZone: bridgeZone } = useSchedules();
  const [pending, setPending] = useState<ScheduleLocation>(scheduleLocation);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPending(scheduleLocation());
      setQuery("");
      setError(null);
    }
  }, [open]);

  const results = useMemo(() => searchPlaces(query), [query]);
  const now = Date.now();
  const offset = (zone: string) => zoneOffset(zone, now);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await schedules.setLocation(pending);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      log.warn("ui", "schedule.location_failed", String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("schedule.location.title")}</DialogTitle>
          <DialogDescription className="text-xs">{t("schedule.location.hint")}</DialogDescription>
        </DialogHeader>

        <WorldMap location={pending} onPick={(lat, lon) => setPending(locationAt(lat, lon))} />

        <div className="flex items-start gap-2 text-xs">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">{pending.name}</p>
            <p className="text-[11px] text-muted-foreground">
              {formatCoordinates(pending)} · {pending.timeZone} · {formatOffset(offset(pending.timeZone))}
            </p>
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("schedule.location.search")}
            className="h-8 pl-8 text-xs"
            aria-label={t("schedule.location.search")}
          />
          {results.length > 0 && (
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-popover p-1">
              {results.map((place) => (
                <li key={place.timeZone}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
                    onClick={() => {
                      setPending(place);
                      setQuery("");
                    }}
                  >
                    <span className="truncate">{place.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatOffset(offset(place.timeZone))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">{t("schedule.location.bridge_note")}</p>

        {error && (
          <p role="alert" data-selectable className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const home = zoneLocation(bridgeZone);
              if (home) setPending(home);
            }}
          >
            {t("schedule.location.use_bridge")}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {t("schedule.editor.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorldMap({ location, onPick }: { location: ScheduleLocation; onPick: (lat: number, lon: number) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const night = useMemo(() => nightPolygon(Date.now()), []);
  const band = Math.round(location.lon / 15);

  const pick = (event: React.PointerEvent) => {
    const el = svg.current;
    const matrix = el?.getScreenCTM()?.inverse();
    if (!el || !matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    const lon = Math.min(180, Math.max(-180, point.x - 180));
    const lat = Math.min(NORTH, Math.max(SOUTH, 90 - point.y));
    onPick(lat, lon);
  };

  return (
    <svg
      ref={svg}
      viewBox={VIEW}
      className="block w-full cursor-crosshair touch-none rounded-md border border-border bg-sky-100 select-none dark:bg-slate-900"
      role="application"
      aria-label={t("schedule.location.map")}
      onPointerDown={(event) => {
        dragging.current = true;
        (event.target as Element).setPointerCapture?.(event.pointerId);
        pick(event);
      }}
      onPointerMove={(event) => dragging.current && pick(event)}
      onPointerUp={() => (dragging.current = false)}
    >
      {/* Nominal time zones: 15° bands centered on multiples of 15°. */}
      {Array.from({ length: 25 }, (_, i) => i - 12).map((k) => (
        <rect
          key={k}
          x={k * 15 - 7.5 + 180}
          y={90 - NORTH}
          width={15}
          height={NORTH - SOUTH}
          className={cn(
            k === band ? "fill-primary/25" : k % 2 === 0 ? "fill-black/[0.04] dark:fill-white/[0.04]" : "fill-transparent",
          )}
        />
      ))}
      <path d={WORLD_LAND} className="fill-emerald-700/35 stroke-emerald-900/30 dark:fill-emerald-400/20 dark:stroke-emerald-300/20" strokeWidth={0.2} />
      <path d={night} className="fill-slate-950/30 dark:fill-black/45" />
      {Array.from({ length: 25 }, (_, i) => i - 12)
        .filter((k) => k % 3 === 0)
        .map((k) => (
          <text key={k} x={k * 15 + 180} y={90 - NORTH + 5} textAnchor="middle" fontSize={3.6} className="fill-muted-foreground">
            {k === 0 ? "UTC" : k > 0 ? `+${k}` : k}
          </text>
        ))}
      <g transform={`translate(${location.lon + 180} ${90 - location.lat})`} className="pointer-events-none">
        <circle r={4} className="fill-primary/25" />
        <circle r={1.6} className="fill-primary stroke-background" strokeWidth={0.6} />
      </g>
    </svg>
  );
}

/** Where it's night now, as a polygon in map coordinates. */
function nightPolygon(ms: number): string {
  const date = new Date(ms);
  const dayOfYear = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86_400_000;
  const rad = Math.PI / 180;
  // Sun's declination and the longitude where it's noon (with the equation of time).
  const declination = -23.44 * Math.cos(rad * (360 / 365) * (dayOfYear + 10));
  const b = rad * (360 / 365) * (dayOfYear - 81);
  const equationOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b); // minutes
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + equationOfTime / 60;
  const subsolar = -15 * (utcHours - 12);
  const tanDec = Math.tan(rad * (Math.abs(declination) < 0.1 ? 0.1 : declination));

  const points: string[] = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const lat = Math.atan(-Math.cos(rad * (lon - subsolar)) / tanDec) / rad;
    points.push(`${lon + 180},${90 - lat}`);
  }
  // Night covers the pole away from the sun.
  const pole = declination > 0 ? 180 : 0;
  return `M0,${pole} L${points.join(" L")} L360,${pole} Z`;
}

function formatCoordinates({ lat, lon }: ScheduleLocation): string {
  const f = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;
  return `${f(lat, "N", "S")}, ${f(lon, "E", "W")}`;
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "−";
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}
