import { Lightbulb } from "lucide-react";
import { useAppVersion } from "@/core/useAppVersion";
import { t } from "@/i18n";

export function AboutTab() {
  const version = useAppVersion();

  return (
    <div className="space-y-4 py-4 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
        <Lightbulb className="size-7" aria-hidden />
      </div>
      <div>
        <h2 className="font-semibold">{t("app.product_name")}</h2>
        {version && (
          <p className="text-xs text-muted-foreground">{t("about.version", { version })}</p>
        )}
      </div>
      <p className="text-sm">{t("about.description")}</p>
      <div className="space-y-2 rounded-lg bg-card p-3 text-left text-xs text-muted-foreground">
        <p>{t("about.local")}</p>
        <p>{t("about.cloud")}</p>
      </div>
    </div>
  );
}
