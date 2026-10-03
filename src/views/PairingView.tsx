// Pairing in two steps: find the bridge (network search or manual IP), then
// press its link button and pair. Used on first start and from
// Options → Bridge ("Pair a different bridge").

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Radar, Router } from "lucide-react";
import { useNow } from "@/components/schedule/describe";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { actions } from "@/core/app";
import { LINK_WAIT_MS } from "@/hue/client";
import { t, type MessageKey } from "@/i18n";
import { formatCountdown } from "@/lib/time";
import type { BridgeCandidate } from "@/types";

type Props = {
  /** Shown as "Back" on the first step when pairing is optional. */
  onCancel?: () => void;
  onPaired?: () => void;
};

export function PairingView({ onCancel, onPaired }: Props) {
  const [selected, setSelected] = useState<BridgeCandidate | null>(null);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-sm space-y-5 p-5 pb-10">
        <header className="space-y-1 pt-4 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Router className="size-6" aria-hidden />
          </div>
          <h1 className="text-lg font-semibold">{t("pairing.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("pairing.subtitle")}</p>
        </header>

        {selected ? (
          <PressStep bridge={selected} onBack={() => setSelected(null)} onPaired={onPaired} />
        ) : (
          <FindStep onSelect={setSelected} onCancel={onCancel} />
        )}
      </div>
    </ScrollArea>
  );
}

function FindStep({
  onSelect,
  onCancel,
}: {
  onSelect: (bridge: BridgeCandidate) => void;
  onCancel?: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<BridgeCandidate[] | null>(null);
  const [manualIp, setManualIp] = useState("");

  const search = async () => {
    setSearching(true);
    try {
      setFound(await actions.discover());
    } finally {
      setSearching(false);
    }
  };

  return (
    <section className="space-y-4">
      <StepTitle number={1} title={t("pairing.step_find")} />

      <Button className="w-full" onClick={() => void search()} disabled={searching}>
        {searching ? <Spinner /> : <Radar />}
        {searching
          ? t("pairing.searching")
          : found
            ? t("pairing.search_again")
            : t("pairing.search")}
      </Button>

      {found && found.length === 0 && (
        <p className="text-center text-sm text-muted-foreground">{t("pairing.not_found")}</p>
      )}

      {found && found.length > 0 && (
        <ul className="space-y-1.5">
          {found.map((bridge) => (
            <li key={bridge.id}>
              <button
                type="button"
                onClick={() => onSelect(bridge)}
                className="flex w-full items-center gap-3 rounded-lg bg-card px-3 py-2.5 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Router className="size-4 text-muted-foreground" aria-hidden />
                <span className="flex-1">
                  <span className="block font-mono text-sm">{bridge.ip}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`pairing.source.${bridge.source}` as MessageKey)}
                  </span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const ip = manualIp.trim();
          if (ip) onSelect({ id: ip, ip, source: "manual" });
        }}
      >
        <Label htmlFor="manual-ip" className="text-xs text-muted-foreground">
          {t("pairing.manual_label")}
        </Label>
        <div className="flex gap-2">
          <Input
            id="manual-ip"
            inputMode="decimal"
            placeholder={t("pairing.ip_placeholder")}
            value={manualIp}
            onChange={(event) => setManualIp(event.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!manualIp.trim()}>
            {t("pairing.use_ip")}
          </Button>
        </div>
      </form>

      {onCancel && (
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      )}
    </section>
  );
}

function PressStep({
  bridge,
  onBack,
  onPaired,
}: {
  bridge: BridgeCandidate;
  onBack: () => void;
  onPaired?: () => void;
}) {
  /** When the wait for the button ends; null when not waiting. */
  const [deadline, setDeadline] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Leaving the step (Back, closing Options) must not pair in the background.
  const wait = useRef<AbortController | null>(null);
  useEffect(() => () => wait.current?.abort(), []);

  const pair = async () => {
    const controller = new AbortController();
    wait.current = controller;
    setDeadline(Date.now() + LINK_WAIT_MS);
    setError(null);
    const result = await actions.pair(bridge.ip, controller.signal);
    if (controller.signal.aborted) return;
    setDeadline(null);
    if (result.ok) onPaired?.();
    else setError(result.error ?? t("pairing.pair_failed"));
  };

  const cancel = () => {
    wait.current?.abort();
    setDeadline(null);
  };

  return (
    <section className="space-y-4">
      <StepTitle number={2} title={t("pairing.step_press")} />
      <p className="text-sm text-muted-foreground">
        {t("pairing.press_hint", { ip: bridge.ip })}
      </p>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {deadline ? (
        <div className="flex gap-2">
          <Button variant="ghost" onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button className="flex-1" disabled>
            <Spinner />
            <WaitCountdown deadline={deadline} />
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft />
            {t("pairing.back")}
          </Button>
          <Button className="flex-1" onClick={() => void pair()}>
            {t("pairing.pair")}
          </Button>
        </div>
      )}
    </section>
  );
}

/** "Waiting for the button… 1:24" - its own component, so only it re-renders each second. */
function WaitCountdown({ deadline }: { deadline: number }) {
  const now = useNow();
  return <span aria-live="off">{t("pairing.waiting", { time: formatCountdown(deadline - now) })}</span>;
}

function StepTitle({ number, title }: { number: number; title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold">
      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
        {number}
      </span>
      {title}
    </h2>
  );
}
