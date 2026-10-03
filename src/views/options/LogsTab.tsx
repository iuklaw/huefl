// Options -> Logs: recent actions and events, newest first. Meant for the user
// ("what just happened?") and for bug reports ("Copy" gives a ready-to-paste
// text with app version and system info).

import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Check, ChevronDown, Copy, Search, Trash2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { log, type LogEntry, type LogLevel } from "@/core/log";
import { useLogs } from "@/core/useLogs";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];
/** Newest entries are shown in pages; "Show more" adds the next one. */
const PAGE_SIZE = 50;

const DOT: Record<LogLevel, string> = {
  debug: "bg-muted-foreground/50",
  info: "bg-sky-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
};

export function LogsTab() {
  const { entries, path, clear } = useLogs();
  const [minLevel, setMinLevel] = useState<LogLevel>("info");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => RANK[e.level] >= RANK[minLevel])
      .filter(
        (e) =>
          !q ||
          e.message.toLowerCase().includes(q) ||
          e.event.toLowerCase().includes(q) ||
          e.source.includes(q),
      );
  }, [entries, minLevel, query]);

  // A new filter starts from the top instead of an earlier expanded list.
  useEffect(() => setLimit(PAGE_SIZE), [minLevel, query]);

  const copy = async () => {
    const header = [
      `${t("app.product_name")} ${await getVersion()}`,
      navigator.userAgent,
      `Exported ${new Date().toISOString()}, ${visible.length} entries (level ≥ ${minLevel})`,
      "",
    ];
    const lines = visible.map(
      (e) =>
        `${new Date(e.ts).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.source} ${e.event}: ${e.message}` +
        (e.data !== undefined ? ` ${JSON.stringify(e.data)}` : ""),
    );
    try {
      await navigator.clipboard.writeText([...header, ...lines].join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      log.warn("ui", "logs.copy_failed", "Copying logs to the clipboard failed", { error });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("logs.search")}
            aria-label={t("logs.search")}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <Select value={minLevel} onValueChange={(value) => setMinLevel(value as LogLevel)}>
          <SelectTrigger size="sm" className="w-auto text-xs" aria-label={t("logs.level_label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {LEVELS.map((level) => (
              <SelectItem key={level} value={level} className="text-xs">
                {t(`logs.level.${level}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t("logs.count", { shown: visible.length, total: entries.length })}
        </p>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => void copy()} disabled={!visible.length}>
            {copied ? <Check /> : <Copy />}
            {copied ? t("logs.copied") : t("logs.copy")}
          </Button>
          <ClearButton
            onConfirm={() => {
              setLimit(PAGE_SIZE);
              void clear();
            }}
            disabled={!entries.length}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {entries.length ? t("logs.no_match") : t("logs.empty")}
        </p>
      ) : (
        <ol className="overflow-hidden rounded-lg bg-card">
          {visible
            .slice()
            .reverse()
            .slice(0, limit)
            .map((entry, index) => {
              const id = `${entry.ts}-${index}`;
              return (
                <LogRow
                  key={id}
                  entry={entry}
                  open={open === id}
                  onToggle={() => setOpen(open === id ? null : id)}
                />
              );
            })}
        </ol>
      )}

      {visible.length > limit && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground"
          onClick={() => setLimit((current) => current + PAGE_SIZE)}
        >
          <ChevronDown />
          {t("logs.show_more", { count: visible.length - limit })}
        </Button>
      )}

      {path && (
        <div className="space-y-0.5 pt-1">
          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("logs.file")}
          </p>
          <p data-selectable className="font-mono text-[11px] break-all text-muted-foreground">
            {path}
          </p>
        </div>
      )}
    </div>
  );
}

function LogRow({
  entry,
  open,
  onToggle,
}: {
  entry: LogEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const time = new Date(entry.ts);
  const clock =
    time.toLocaleTimeString(undefined, { hour12: false }) +
    `.${String(time.getMilliseconds()).padStart(3, "0")}`;

  return (
    <li className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_auto_1fr] items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent"
      >
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{clock}</span>
        <span className={cn("size-1.5 translate-y-[-1px] rounded-full", DOT[entry.level])} aria-label={entry.level} />
        <span className={cn("min-w-0 text-xs", !open && "truncate", entry.level === "error" && "text-destructive")}>
          <span className="mr-1.5 text-[10px] font-semibold text-muted-foreground uppercase">
            {entry.source}
          </span>
          {entry.message}
        </span>
      </button>
      {open && (
        <pre
          data-selectable
          className="mx-2.5 mb-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all"
        >
          {JSON.stringify(
            {
              [t("logs.time")]: time.toISOString(),
              level: entry.level,
              [t("logs.event")]: entry.event,
              ...(entry.data !== undefined ? { data: entry.data } : {}),
            },
            null,
            2,
          )}
        </pre>
      )}
    </li>
  );
}

function ClearButton({ onConfirm, disabled }: { onConfirm: () => void; disabled: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="xs" variant="ghost" disabled={disabled}>
          <Trash2 />
          {t("logs.clear")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("logs.clear_title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("logs.clear_description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {t("logs.clear_confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
