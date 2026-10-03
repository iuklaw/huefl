// "Version X is available": the release notes, then download & install with
// progress, then restart into it. Opened from the title bar's badge and from
// Options -> About; mounted once in App.

import { useSyncExternalStore } from "react";
import { Download, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { updates, useUpdates } from "@/core/updates";
import { t } from "@/i18n";

let open = false;
const listeners = new Set<() => void>();
function setOpen(next: boolean): void {
  open = next;
  for (const listener of listeners) listener();
}
export const openUpdateDialog = () => setOpen(true);

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

export function UpdateDialog() {
  const isOpen = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
  const update = useUpdates();
  const info =
    update.status === "available" || update.status === "downloading" || update.status === "ready"
      ? update.info
      : update.status === "error"
        ? update.info
        : null;
  if (!info) return null;

  const downloading = update.status === "downloading";
  const percent =
    downloading && update.total ? Math.min(100, Math.round((update.downloaded / update.total) * 100)) : null;

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !downloading && setOpen(next)}>
      <DialogContent className="gap-3 sm:max-w-md" showCloseButton={!downloading}>
        <DialogHeader>
          <DialogTitle className="text-sm">{t("update.title", { version: info.version })}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("update.current", { current: info.current })}
          </DialogDescription>
        </DialogHeader>

        {info.notes && (
          <pre
            data-selectable
            className="max-h-48 overflow-y-auto rounded-md bg-muted p-2.5 font-sans text-xs whitespace-pre-wrap"
          >
            {info.notes}
          </pre>
        )}

        {downloading && (
          <div className="space-y-1" role="status" aria-live="polite">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${percent ?? 15}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {update.total
                ? t("update.progress", { done: megabytes(update.downloaded), total: megabytes(update.total) })
                : t("update.downloading")}
            </p>
          </div>
        )}

        {update.status === "ready" && <p className="text-xs">{t("update.ready")}</p>}

        {update.status === "error" && (
          <p role="alert" data-selectable className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {t("update.failed")} {update.message} {t("update.manual")}
          </p>
        )}

        {!downloading && update.status !== "ready" && (
          <p className="text-[11px] text-muted-foreground">{t("update.password_hint")}</p>
        )}

        <DialogFooter>
          {update.status === "ready" ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {t("update.restart_later")}
              </Button>
              <Button size="sm" onClick={() => void updates.restart()}>
                <RotateCw />
                {t("update.restart")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={downloading}
                onClick={() => {
                  void updates.later();
                  setOpen(false);
                }}
              >
                {t("update.later")}
              </Button>
              <Button size="sm" disabled={downloading} onClick={() => void updates.install()}>
                {downloading ? <Spinner /> : <Download />}
                {t("update.install")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
