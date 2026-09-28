// Options: a full-window view (like Discord's settings) with tabs.
// Esc or the back button returns to the rooms.

import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t } from "@/i18n";
import type { AppState } from "@/types";
import { AboutTab } from "./options/AboutTab";
import { BridgeTab } from "./options/BridgeTab";
import { GeneralTab } from "./options/GeneralTab";
import { LightsTab } from "./options/LightsTab";
import { LogsTab } from "./options/LogsTab";

export type OptionsTab = "general" | "bridge" | "lights" | "logs" | "about";

const TABS: OptionsTab[] = ["general", "bridge", "lights", "logs", "about"];

type Props = {
  state: AppState;
  tab: OptionsTab;
  onTabChange: (tab: OptionsTab) => void;
  onBack: () => void;
};

export function OptionsView({ state, tab, onTabChange, onBack }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Let open dialogs handle Esc themselves.
      if (event.key === "Escape" && !document.querySelector("[role=alertdialog]")) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as OptionsTab)}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <div className="shrink-0 border-b border-border px-3 pt-2">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label={t("options.back")}>
            <ArrowLeft />
          </Button>
          <h1 className="text-sm font-semibold">{t("options.title")}</h1>
        </div>
        <TabsList variant="line" className="mt-1 w-full justify-start overflow-x-auto">
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="flex-none px-2.5">
              {t(`options.tab.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* pb-10: room to scroll the last item above the footer bar. */}
        <div className="p-4 pb-10">
          <TabsContent value="general">
            <GeneralTab preferences={state.preferences} />
          </TabsContent>
          <TabsContent value="bridge">
            <BridgeTab state={state} />
          </TabsContent>
          <TabsContent value="lights">
            <LightsTab state={state} />
          </TabsContent>
          <TabsContent value="logs">
            <LogsTab />
          </TabsContent>
          <TabsContent value="about">
            <AboutTab />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  );
}
