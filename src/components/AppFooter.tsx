// A thin translucent bar along the bottom of the window: product name on the
// left, version on the right (the same values as Options -> About). It overlays
// the views, so the room glow shows through; the views leave room for it.

import { useAppVersion } from "@/core/useAppVersion";
import { t } from "@/i18n";

export function AppFooter() {
  const version = useAppVersion();

  return (
    <footer
      role="contentinfo"
      className="absolute inset-x-0 bottom-0 z-20 flex h-6 items-center justify-between border-t border-border/60 bg-titlebar/70 px-3 text-[10px] text-muted-foreground backdrop-blur-sm select-none"
    >
      <span className="font-medium tracking-wide">{t("app.product_name")}</span>
      {version && <span className="font-mono tabular-nums">v{version}</span>}
    </footer>
  );
}
