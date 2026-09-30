// "Report a bug" (Options → About): a description and —
// if the user agrees — the app's log and facts about the system. The exact
// report is shown before it leaves. Send delivers it to the report server set
// when building (src-tauri/src/report.rs); a build without one does nothing.

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { log } from "@/core/log";
import {
  buildReport,
  DESCRIPTION_MAX,
  loadReportParts,
  reportMarkdown,
  sendReport,
  type BugReport,
  type ReportParts,
} from "@/core/report";
import { t } from "@/i18n";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

const PREVIEW_LOG_LINES = 200;


export function BugReportDialog({ open, onOpenChange }: Props) {
  const [description, setDescription] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [includeSystem, setIncludeSystem] = useState(true);
  const [parts, setParts] = useState<ReportParts | null>(null);
  const [report, setReport] = useState<BugReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server's id for the report, once sent. */
  const [sentId, setSentId] = useState<string | null>(null);

  // Fresh logs and system facts each time the form opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSentId(null);
    void loadReportParts()
      .then(setParts)
      .catch((e) => log.warn("ui", "report.parts_failed", String(e)));
  }, [open]);

  // The report exactly as it would go out — for the preview and the actions.
  useEffect(() => {
    if (!open) return;
    void buildReport({ description, parts, includeSystem, includeLogs }).then(setReport);
  }, [open, description, parts, includeSystem, includeLogs]);

  // The preview shows the log's end only: the whole log can be megabytes.
  const preview = useMemo(() => (report ? reportMarkdown(report, PREVIEW_LOG_LINES) : ""), [report]);
  const send = async () => {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      const id = await sendReport(report);
      // null: this build has no report server — nothing happens for now.
      if (id !== null) setSentId(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // After a successful send, start clean next time.
        if (!next && sentId !== null) {
          setDescription("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("report.title")}</DialogTitle>
          <DialogDescription className="text-xs">{t("report.hint")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <Label htmlFor="report-description" className="text-xs">
            {t("report.description")}
          </Label>
          <textarea
            id="report-description"
            value={description}
            onChange={(event) => setDescription(event.target.value.slice(0, DESCRIPTION_MAX))}
            placeholder={t("report.description_placeholder")}
            rows={6}
            className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-right text-[11px] text-muted-foreground tabular-nums">
            {description.trim().length} / {DESCRIPTION_MAX}
          </p>
        </div>


        <div className="space-y-2">
          <Option
            id="report-logs"
            checked={includeLogs}
            onChange={setIncludeLogs}
            label={t("report.include_logs")}
          />
          <Option
            id="report-system"
            checked={includeSystem}
            onChange={setIncludeSystem}
            label={t("report.include_system")}
          />
        </div>

        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            {t("report.preview")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre
              data-selectable
              className="mt-1.5 max-h-48 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-snug whitespace-pre-wrap"
            >
              {preview}
            </pre>
          </CollapsibleContent>
        </Collapsible>

        {error && (
          <p role="alert" data-selectable className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {sentId !== null && (
          <p role="status" data-selectable className="flex items-start gap-1.5 rounded-md bg-primary/10 p-2 text-xs">
            <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
            {t("report.sent", { id: sentId || "—" })}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t(sentId !== null ? "report.close" : "common.cancel")}
          </Button>
          <Button size="sm" disabled={!report || busy || sentId !== null} onClick={() => void send()}>
            {busy ? <Spinner /> : <Send />}
            {t("report.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Option({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
    </div>
  );
}
