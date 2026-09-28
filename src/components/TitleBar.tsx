// Custom title bar for the frameless window (decorations: false in
// tauri.conf.json). The bar itself is the drag handle; buttons are not.

import type { ComponentProps } from "react";
import { Lightbulb, Minus, Settings, X } from "lucide-react";
import { actions } from "@/core/app";
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
        {t("app.name")}
      </span>

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
