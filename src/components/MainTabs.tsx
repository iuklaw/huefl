// The two main views, under the title bar: Lights and Sync. While a sync runs
// (even started from the tray), the Sync tab carries a pulsing dot.

import { useSyncState } from "@/core/useSyncState";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export type MainTab = "lights" | "sync";
const TABS: MainTab[] = ["lights", "sync"];

export function MainTabs({
  value,
  onChange,
}: {
  value: MainTab;
  onChange: (tab: MainTab) => void;
}) {
  const { status } = useSyncState();
  const live = status.state === "streaming" || status.state === "starting";

  return (
    <nav className="shrink-0 px-3 pt-2" aria-label={t("nav.lights")}>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={value === tab}
            onClick={() => onChange(tab)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md py-1 text-xs font-medium transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring",
              value === tab
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`nav.${tab}`)}
            {tab === "sync" && live && (
              <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
            )}
          </button>
        ))}
      </div>
    </nav>
  );
}
