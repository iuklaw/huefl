import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { actions } from "@/core/app";
import { t } from "@/i18n";
import type { AppState } from "@/types";

type Props = {
  state: AppState;
  onOpenBridgeSettings: () => void;
};

/** Shown only when the bridge connection is not healthy. */
export function StatusBanner({ state, onOpenBridgeSettings }: Props) {
  if (state.status === "connecting") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        {t("status.connecting")}
      </div>
    );
  }

  if (state.status !== "error") return null;

  return (
    <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t("status.error_title")}</p>
          <p data-selectable className="mt-0.5 text-xs break-words text-muted-foreground">
            {state.error}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onOpenBridgeSettings}>
          {t("status.bridge_settings")}
        </Button>
        <Button size="sm" onClick={() => void actions.reconnect()}>
          {t("status.retry")}
        </Button>
      </div>
    </div>
  );
}
