// One light in a room's "Lights" list. Clicking the row expands it (color
// wheel for color lights, a note for white ones). Smart plugs have nothing to
// adjust, so they get no chevron.

import { ChevronRight, Sun, Thermometer } from "lucide-react";
import { LevelSlider } from "@/components/LevelSlider";
import { LightColorPicker } from "@/components/LightColorPicker";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { actions } from "@/core/app";
import { log } from "@/core/log";
import { t } from "@/i18n";
import { toCss } from "@/lib/color";
import { cn } from "@/lib/utils";
import type { LightView } from "@/types";

type Props = {
  light: LightView;
  syncing: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
};

export function LightRow({ light, syncing, expanded, onExpandedChange }: Props) {
  const { capabilities } = light;
  /** In color (xy) mode the bridge reports no temperature. */
  const whiteMode = light.mirek !== null;
  const expandable =
    light.reachable && (capabilities.color || capabilities.temperature || capabilities.dimming);

  const logCommit = (change: string, data: Record<string, number>) =>
    log.info("command", "command.user", `${light.name}: ${change}`, {
      origin: "ui",
      light: { id: light.id, name: light.name },
      ...data,
    });

  const header = (
    <>
      {expandable && (
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      )}
      {syncing ? (
        <Spinner className="size-3 shrink-0 text-primary" aria-hidden />
      ) : (
        <span
          className="mx-0.5 size-2 shrink-0 rounded-full bg-muted-foreground/40 ring-1 ring-black/10"
          style={
            light.on && light.reachable && light.color
              ? { backgroundColor: toCss(light.color) }
              : undefined
          }
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1 truncate text-sm">{light.name}</span>
      {!light.reachable && (
        <Badge variant="outline" className="text-[10px]">
          {t("light.unreachable")}
        </Badge>
      )}
    </>
  );

  return (
    <Collapsible
      open={expandable && expanded}
      onOpenChange={onExpandedChange}
      className={cn(
        "rounded-md px-2 py-2 transition-colors hover:bg-accent/60",
        !light.reachable && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        {expandable ? (
          // The switch stays outside the trigger, so toggling never expands.
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("light.expand_label", { name: light.name })}
          >
            {header}
          </CollapsibleTrigger>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-5">{header}</div>
        )}
        <Switch
          size="sm"
          checked={light.on}
          disabled={!light.reachable}
          onCheckedChange={(on) => void actions.setLight({ id: light.id, on })}
          aria-label={t("light.toggle_label", { name: light.name })}
        />
      </div>

      {light.reachable && (capabilities.dimming || light.mirekRange) && (
        <div className="mt-2 pl-5">
          {capabilities.dimming && (
            <LevelSlider
              icon={<Sun />}
              label={t("light.brightness_label", { name: light.name })}
              value={Math.max(1, light.brightness)}
              onChange={(brightness) =>
                void actions.setLight({ id: light.id, brightness, on: true })
              }
              onCommit={(brightness) => logCommit(`brightness ${brightness}%`, { brightness })}
            />
          )}
          {light.mirekRange && (
            // Temperature only applies in white mode. The slider stays mounted
            // and slides open/closed (grid rows 0fr <-> 1fr) as the light
            // switches between white ("Reset") and a picked color.
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
                whiteMode ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
              aria-hidden={!whiteMode}
              inert={!whiteMode}
            >
              <div className="min-h-0 overflow-hidden">
                <LevelSlider
                  className={cn("pb-0.5", capabilities.dimming && "pt-2")}
                  variant="temperature"
                  icon={<Thermometer />}
                  label={t("light.temperature_label", { name: light.name })}
                  min={light.mirekRange.min}
                  max={light.mirekRange.max}
                  value={light.mirek ?? light.mirekRange.min}
                  onChange={(mirek) => void actions.setLight({ id: light.id, mirek, on: true })}
                  onCommit={(mirek) =>
                    logCommit(`color temperature ${Math.round(1_000_000 / mirek)} K`, { mirek })
                  }
                />
              </div>
            </div>
          )}
        </div>
      )}

      {expandable && (
        <CollapsibleContent className="overflow-hidden pl-5 data-open:animate-collapsible-down data-closed:animate-collapsible-up">
          <LightColorPicker light={light} />
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
