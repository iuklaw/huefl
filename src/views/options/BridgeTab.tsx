import { useState } from "react";
import { Eye, EyeOff, RefreshCw, Router, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { actions } from "@/core/app";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { AppState } from "@/types";
import { PairingView } from "../PairingView";
import { Section } from "./Section";

export function BridgeTab({ state }: { state: AppState }) {
  const [pairing, setPairing] = useState(false);
  const bridge = state.bridge;

  if (pairing) {
    return (
      <div className="-m-4 flex min-h-[520px] flex-col">
        <PairingView onCancel={() => setPairing(false)} onPaired={() => setPairing(false)} />
      </div>
    );
  }

  if (!bridge) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <Router className="size-10 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{t("bridge.none")}</p>
        <Button onClick={() => setPairing(true)}>{t("bridge.pair_first")}</Button>
      </div>
    );
  }

  const unknown = t("common.unknown");
  const fields: Array<[string, string | null, boolean?]> = [
    [t("bridge.field.name"), bridge.name],
    [t("bridge.field.ip"), bridge.ip],
    [t("bridge.field.id"), bridge.bridgeId?.toUpperCase() ?? null, true],
    [t("bridge.field.model"), bridge.modelId],
    [t("bridge.field.firmware"), bridge.softwareVersion],
    [t("bridge.field.timezone"), bridge.timeZone],
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-lg bg-card p-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Router className="size-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{bridge.name ?? bridge.ip}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{bridge.ip}</p>
        </div>
        <StatusBadge status={state.status} />
      </div>

      <Section title={t("options.tab.bridge")}>
        <dl className="divide-y divide-border overflow-hidden rounded-lg bg-card text-sm">
          {fields.map(([label, value, hidden]) => (
            <div key={label} className="flex items-center justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground">{label}</dt>
              {hidden && value ? (
                <HiddenValue value={value} />
              ) : (
                <dd data-selectable className="truncate text-right">
                  {value ?? unknown}
                </dd>
              )}
            </div>
          ))}
        </dl>
      </Section>

      <Section title={t("bridge.field.fingerprint")} description={t("bridge.fingerprint_hint")}>
        <p
          data-selectable
          className="rounded-lg bg-card px-3 py-2 font-mono text-[11px] leading-relaxed break-all"
        >
          {bridge.fingerprint ?? unknown}
        </p>
      </Section>

      <div className="flex flex-col gap-2">
        <Button variant="secondary" onClick={() => void actions.reconnect()}>
          <RefreshCw />
          {t("bridge.reconnect")}
        </Button>
        <Button variant="secondary" onClick={() => setPairing(true)}>
          <Router />
          {t("bridge.pair_other")}
        </Button>
        <ForgetButton />
      </div>
    </div>
  );
}

function HiddenValue({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <dd className="flex min-w-0 items-center gap-1">
      {shown ? (
        <span data-selectable className="truncate">
          {value}
        </span>
      ) : (
        <span aria-hidden className="tracking-widest">
          ••••••••••••
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={shown ? t("common.hide") : t("common.show")}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </dd>
  );
}

function StatusBadge({ status }: { status: AppState["status"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        status === "ready" && "text-success",
        status === "error" && "text-destructive",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "ready" && "bg-success",
          status === "connecting" && "animate-pulse bg-primary",
          status === "error" && "bg-destructive",
          status === "unconfigured" && "bg-muted-foreground",
        )}
        aria-hidden
      />
      {t(`bridge.status.${status}`)}
    </Badge>
  );
}

function ForgetButton() {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" className="text-destructive hover:text-destructive">
          <Trash2 />
          {t("bridge.forget")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("bridge.forget_title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("bridge.forget_description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void actions.forget()}>
            {t("bridge.forget_confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
