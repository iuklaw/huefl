import { useState } from "react";
import { Bug, RefreshCw } from "lucide-react";
import { HueflLogo } from "@/components/HueflLogo";
import { BugReportDialog } from "@/components/BugReportDialog";
import { openUpdateDialog } from "@/components/UpdateDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { actions } from "@/core/app";
import { updates, useUpdates } from "@/core/updates";
import { useAppState } from "@/core/useAppState";
import { useAppVersion } from "@/core/useAppVersion";
import { t } from "@/i18n";

export function AboutTab() {
  const version = useAppVersion();
  const [reporting, setReporting] = useState(false);

  return (
    <div className="space-y-4 py-4 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted">
        <HueflLogo className="size-8" />
      </div>
      <div>
        <h2 className="font-semibold">{t("app.product_name")}</h2>
        <p className="text-xs text-muted-foreground">{t("about.subtitle")}</p>
        {version && (
          <p className="text-xs text-muted-foreground">{t("about.version", { version })}</p>
        )}
      </div>
      <p className="text-sm">{t("about.description")}</p>

      <UpdatesSection />

      <Button
        variant="outline"
        size="sm"
        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setReporting(true)}
      >
        <Bug />
        {t("report.open")}
      </Button>

      <BugReportDialog open={reporting} onOpenChange={setReporting} />
    </div>
  );
}

/** "Check for updates" and its result; the automatic check's switch. */
function UpdatesSection() {
  const update = useUpdates();
  const { preferences } = useAppState();
  const offer = update.status === "available" || update.status === "downloading" || update.status === "ready";

  if (update.status === "managed") {
    return (
      <p className="mx-auto max-w-xs text-xs text-muted-foreground">
        {update.by === "flathub" ? t("update.via_flathub") : t("update.via_package")}
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-xs space-y-2 rounded-lg bg-card p-3 text-left">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs" aria-live="polite">
          {update.status === "checking"
            ? t("update.checking")
            : update.status === "upToDate"
              ? t("update.up_to_date")
              : offer
                ? t("update.available_short", { version: update.info.version })
                : update.status === "error"
                  ? t("update.check_failed")
                  : update.status === "unavailable"
                    ? t("update.unavailable")
                    : null}
        </p>
        {offer ? (
          <Button size="xs" onClick={openUpdateDialog}>
            {t("update.open")}
          </Button>
        ) : (
          <Button
            size="xs"
            variant="secondary"
            disabled={update.status === "checking"}
            onClick={() => void updates.check(true)}
          >
            {update.status === "checking" ? <Spinner /> : <RefreshCw />}
            {t("update.check")}
          </Button>
        )}
      </div>
      <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        {t("update.auto")}
        <Switch
          checked={preferences.checkForUpdates}
          onCheckedChange={(checkForUpdates) => void actions.setPreferences({ checkForUpdates })}
        />
      </label>
    </div>
  );
}
