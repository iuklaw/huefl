import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { AppState, LightView } from "@/types";
import { Section } from "./Section";

/** Every light the bridge knows, grouped by room, with product details. */
export function LightsTab({ state }: { state: AppState }) {
  if (state.lights.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{t("lights.empty")}</p>;
  }

  const groups = state.rooms.map((room) => ({
    id: room.id,
    title: room.name,
    lights: state.lights.filter((l) => l.roomId === room.id),
  }));
  const unassigned = state.lights.filter((l) => !l.roomId);
  if (unassigned.length > 0) {
    groups.push({ id: "unassigned", title: t("lights.unassigned"), lights: unassigned });
  }

  return (
    <div className="space-y-5">
      {groups
        .filter((group) => group.lights.length > 0)
        .map((group) => (
          <Section key={group.id} title={group.title}>
            <ul className="space-y-1.5">
              {group.lights.map((light) => (
                <LightDetails key={light.id} light={light} />
              ))}
            </ul>
          </Section>
        ))}
    </div>
  );
}

function LightDetails({ light }: { light: LightView }) {
  const unknown = t("common.unknown");
  const capabilities = [
    light.capabilities.dimming && t("lights.cap.dimming"),
    light.mirekRange &&
      t("lights.cap.ambiance", {
        min: toKelvin(light.mirekRange.max),
        max: toKelvin(light.mirekRange.min),
      }),
    light.capabilities.color && t("lights.cap.color"),
  ].filter((c): c is string => Boolean(c));

  return (
    <li className="rounded-lg bg-card p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{light.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {light.product?.name ?? unknown}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(light.reachable ? "text-success" : "text-destructive")}
        >
          {light.reachable ? t("lights.reachable") : t("lights.unreachable")}
        </Badge>
      </div>

      <dl data-selectable className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{t("lights.model")}</dt>
        <dd className="font-mono">{light.product?.modelId ?? unknown}</dd>
        <dt className="text-muted-foreground">{t("lights.firmware")}</dt>
        <dd className="font-mono">{light.product?.softwareVersion ?? unknown}</dd>
      </dl>

      {capabilities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {capabilities.map((capability) => (
            <Badge key={capability} variant="secondary" className="text-[10px]">
              {capability}
            </Badge>
          ))}
        </div>
      )}
    </li>
  );
}

/** Mireds to Kelvin, rounded to 100 K like the Hue app shows it. */
function toKelvin(mirek: number): number {
  return Math.round(1_000_000 / mirek / 100) * 100;
}
