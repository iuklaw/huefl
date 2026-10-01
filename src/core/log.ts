// Logger for the TS side. Entries go to the Rust log store (src-tauri/src/logs.rs),
// which persists them and echoes each one back as a "log-entry" event - so the
// Logs tab shows JS and Rust entries from one ordered source.
//
// Entries are batched (a dragged slider must not mean one IPC call per step)
// and secrets are redacted before anything leaves this module.

import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "app" | "ui" | "bridge" | "command" | "tray" | "pairing";

export type LogEntry = {
  ts: number;
  level: LogLevel;
  source: LogSource;
  event: string;
  message: string;
  data?: unknown;
};

const FLUSH_MS = 250;
const SECRET_KEYS = new Set(["applicationkey", "clientkey", "hue-application-key", "key"]);

let buffer: LogEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  if (buffer.length === 0) return;
  const entries = buffer;
  buffer = [];
  invoke("log_write", { entries }).catch((error) => {
    // Logging must never break the app; the console is the last resort.
    console.error("[log] write failed", error, entries);
  });
}

function write(level: LogLevel, source: LogSource, event: string, message: string, data?: unknown) {
  const entry: LogEntry = { ts: Date.now(), level, source, event, message };
  if (data !== undefined) entry.data = redact(data);
  if (import.meta.env.DEV) {
    const method = level === "debug" ? "debug" : level === "info" ? "info" : level;
    console[method](`[${source}] ${event}: ${message}`, entry.data ?? "");
  }
  buffer.push(entry);
  // Errors go out right away - the app may be about to go down.
  if (level === "error") flush();
  else timer ??= setTimeout(flush, FLUSH_MS);
}

export const log = {
  debug: (source: LogSource, event: string, message: string, data?: unknown) =>
    write("debug", source, event, message, data),
  info: (source: LogSource, event: string, message: string, data?: unknown) =>
    write("info", source, event, message, data),
  warn: (source: LogSource, event: string, message: string, data?: unknown) =>
    write("warn", source, event, message, data),
  error: (source: LogSource, event: string, message: string, data?: unknown) =>
    write("error", source, event, message, data),
};

/** Deep copy with secret fields replaced; also turns Errors into plain data. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

/** Uncaught errors are the ones we most need and least expect. */
export function captureGlobalErrors(): void {
  window.addEventListener("error", (event) => {
    log.error("app", "error.uncaught", event.message, {
      error: event.error,
      at: `${event.filename}:${event.lineno}:${event.colno}`,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    log.error("app", "error.unhandled_rejection", String(reason?.message ?? reason), {
      error: reason,
    });
  });
}
