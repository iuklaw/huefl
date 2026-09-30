// Bug reports, UI side: builds the report the user sees in the form, and
// hands it to Rust to send or save (src-tauri/src/report.rs), which also
// strips the bridge keys from everything once more.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getState } from "@/core/app";
import type { LogEntry } from "@/core/log";

/** Mirrors SystemInfo in report.rs. */
export type SystemInfo = {
  os: string | null;
  kernel: string | null;
  arch: string;
  desktop: string | null;
  sessionType: string | null;
  locale: string | null;
  audioServer: string | null;
  features: string[];
};

export type BugReport = {
  /** Bump when the shape changes; the receiving side reads it first. */
  schema: 1;
  createdAt: string;
  app: { name: "HueFL"; version: string };
  description: string;
  system?: SystemInfo & {
    /** The webview's user agent: WebKitGTK version. */
    webview: string;
    bridge: { model: string | null; firmware: string | null } | null;
  };
  logs?: LogEntry[];
};

export const DESCRIPTION_MAX = 5000;

export type ReportParts = { system: BugReport["system"]; logs: LogEntry[] };

/** What the checkboxes can add; loaded when the form opens. */
export async function loadReportParts(): Promise<ReportParts> {
  const [info, logs] = await Promise.all([
    invoke<SystemInfo>("bug_report_system_info"),
    invoke<LogEntry[]>("bug_report_logs"),
  ]);
  const bridge = getState().bridge;
  return {
    system: {
      ...info,
      webview: navigator.userAgent,
      bridge: bridge ? { model: bridge.modelId, firmware: bridge.softwareVersion } : null,
    },
    logs,
  };
}

export async function buildReport(input: {
  description: string;
  parts: ReportParts | null;
  includeSystem: boolean;
  includeLogs: boolean;
}): Promise<BugReport> {
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    app: { name: "HueFL", version: await getVersion() },
    description: input.description.trim(),
    ...(input.includeSystem && input.parts ? { system: input.parts.system } : {}),
    ...(input.includeLogs && input.parts ? { logs: input.parts.logs } : {}),
  };
}

/**
 * Sends to the report server set when building; resolves with the report's
 * id there — or null in a build without one, where sending does nothing yet.
 */
export async function sendReport(report: BugReport): Promise<string | null> {
  try {
    return await invoke<string>("bug_report_send", { report });
  } catch (error) {
    if (String(error) === "not_configured") return null;
    throw error;
  }
}

/**
 * The report as readable text, for the form's preview. `lastLogLines` keeps
 * only the log's end (what's sent is always whole).
 */
export function reportMarkdown(report: BugReport, lastLogLines?: number): string {
  const lines = [`## Bug report — HueFL ${report.app.version}`, "", report.description, ""];
  if (report.system) {
    const s = report.system;
    lines.push(
      "### System",
      "",
      `- OS: ${s.os ?? "?"} (kernel ${s.kernel ?? "?"}, ${s.arch})`,
      `- Desktop: ${s.desktop ?? "?"} · ${s.sessionType ?? "?"} · ${s.locale ?? "?"}`,
      `- Audio: ${s.audioServer ?? "none"} · features: ${s.features.join(", ") || "none"}`,
      `- Bridge: ${s.bridge ? `${s.bridge.model ?? "?"}, firmware ${s.bridge.firmware ?? "?"}` : "not connected"}`,
      `- Webview: ${s.webview}`,
      "",
    );
  }
  if (report.logs?.length) {
    const shown = lastLogLines === undefined ? report.logs : report.logs.slice(-lastLogLines);
    lines.push(`### Logs (${report.logs.length} entries)`, "", "```");
    if (shown.length < report.logs.length) lines.push(`… ${report.logs.length - shown.length} earlier entries included in the report`);
    for (const entry of shown) {
      const data = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
      lines.push(`${new Date(entry.ts).toISOString()} ${entry.level.padEnd(5)} ${entry.event} ${entry.message}${data}`);
    }
    lines.push("```");
  }
  return lines.join("\n");
}
