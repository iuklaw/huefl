// What light sync needs, as a checklist (evaluated in Rust: sync/readiness.rs).
// Each unmet item says what to do; the sync area can be created right here.

import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import type { ReadinessCheck } from "@/types";

type Props = {
  checks: ReadinessCheck[];
  onCreateArea: () => void;
  onRepair: () => void;
};

/** A check with a `reason` has one message per reason (e.g. audio: no_server). */
function messageKey(check: ReadinessCheck): MessageKey {
  const reason = check.params?.reason;
  return (
    reason ? `sync.check.${check.id}.${reason}` : `sync.check.${check.id}.${check.level}`
  ) as MessageKey;
}

export function Readiness({ checks, onCreateArea, onRepair }: Props) {
  return (
    <ul className="space-y-1">
      {checks.map((check) => {
        const Icon =
          check.level === "ok" ? CircleCheck : check.level === "warning" ? CircleAlert : CircleX;
        return (
          <li key={check.id} className="flex items-center gap-2 rounded-lg bg-card px-2.5 py-1.5">
            <Icon
              className={cn(
                "size-3.5 shrink-0",
                check.level === "ok" && "text-success",
                check.level === "warning" && "text-amber-500",
                check.level === "blocking" && "text-destructive",
              )}
              aria-hidden
            />
            <p className="min-w-0 flex-1 text-xs">{t(messageKey(check), check.params)}</p>
            {check.id === "area" && check.level === "blocking" && (
              <Button size="xs" onClick={onCreateArea}>
                {t("sync.area.create")}
              </Button>
            )}
            {check.id === "client_key" && check.level === "blocking" && (
              <Button size="xs" variant="secondary" onClick={onRepair}>
                {t("sync.repair")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
