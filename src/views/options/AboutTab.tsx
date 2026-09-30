import { useState } from "react";
import { Bug, Lightbulb } from "lucide-react";
import { BugReportDialog } from "@/components/BugReportDialog";
import { Button } from "@/components/ui/button";
import { useAppVersion } from "@/core/useAppVersion";
import { t } from "@/i18n";

export function AboutTab() {
  const version = useAppVersion();
  const [reporting, setReporting] = useState(false);

  return (
    <div className="space-y-4 py-4 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
        <Lightbulb className="size-7" aria-hidden />
      </div>
      <div>
        <h2 className="font-semibold">{t("app.product_name")}</h2>
        <p className="text-xs text-muted-foreground">{t("about.subtitle")}</p>
        {version && (
          <p className="text-xs text-muted-foreground">{t("about.version", { version })}</p>
        )}
      </div>
      <p className="text-sm">{t("about.description")}</p>

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
