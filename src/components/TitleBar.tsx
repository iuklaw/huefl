// Custom title bar for the frameless window (decorations: false in
// tauri.conf.json). The bar itself is the drag handle; buttons are not.

import type { ComponentProps } from "react";
import { ArrowDownToLine, Lightbulb, Minus, Settings, X } from "lucide-react";
import { openUpdateDialog } from "@/components/UpdateDialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { actions } from "@/core/app";
import { useAppState } from "@/core/useAppState";
import { badgeVersion, useUpdates } from "@/core/updates";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

type Props = {
  onOptions: () => void;
  onClose: () => void;
};

export function TitleBar({ onOptions, onClose }: Props) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center bg-titlebar pl-3 text-titlebar-foreground"
    >
      <Lightbulb data-tauri-drag-region className="size-4 text-primary" aria-hidden />
      <span data-tauri-drag-region className="ml-2 text-xs font-semibold tracking-wide">
        {t("app.product_name")}
      </span>
      <UpdateBadge />

      <div className="ml-auto flex h-full">
        <TitleButton label={t("titlebar.options")} onClick={onOptions}>
          <Settings />
        </TitleButton>
        <TitleButton label={t("titlebar.minimize")} onClick={() => void actions.minimize()}>
          <Minus />
        </TitleButton>
        <TitleButton
          label={t("titlebar.close")}
          onClick={onClose}
          className="hover:bg-destructive hover:text-white"
        >
          <X />
        </TitleButton>
      </div>
    </header>
  );
}

/** A newer version is out: a small pill by the name; click to update. */
function UpdateBadge() {
  const update = useUpdates();
  const { preferences } = useAppState();
  const version = badgeVersion(update, preferences.dismissedUpdate);
  if (!version) return null;
  const label = t("update.badge_tooltip", { version });
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openUpdateDialog}
            aria-label={label}
            className="ml-2 flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary outline-none hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowDownToLine className="size-3" aria-hidden />
            {version}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TitleButton({
  label,
  className,
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "flex h-full w-11 items-center justify-center transition-colors outline-none",
        "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent",
        "[&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}
