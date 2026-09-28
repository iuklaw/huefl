import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { actions } from "@/core/app";
import { t } from "@/i18n";
import type { SyncPrefs } from "@/types";
import { Section } from "./Section";

/** Sync defaults that don't belong on the Sync tab itself. */
export function SyncTab({ prefs }: { prefs: SyncPrefs }) {
  return (
    <div className="space-y-5">
      <Section title={t("options.tab.sync")}>
        {/* Applies to music and screen sync alike. */}
        <Label
          htmlFor="sync-restore"
          className="flex cursor-pointer items-start gap-3 rounded-md bg-card px-3 py-2.5 font-normal"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{t("sync.options.restore")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("sync.options.restore_hint")}
            </span>
          </span>
          <Switch
            id="sync-restore"
            checked={prefs.restore}
            onCheckedChange={(restore) => void actions.setSyncPrefs({ restore })}
          />
        </Label>
        <Label
          htmlFor="sync-safe-mode"
          className="flex cursor-pointer items-start gap-3 rounded-md bg-card px-3 py-2.5 font-normal"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{t("sync.safe_mode")}</span>
            <span className="block text-xs text-muted-foreground">{t("sync.safe_mode_hint")}</span>
          </span>
          <Switch
            id="sync-safe-mode"
            checked={prefs.safeMode}
            onCheckedChange={(safeMode) => void actions.setSyncPrefs({ safeMode })}
          />
        </Label>
      </Section>
    </div>
  );
}
