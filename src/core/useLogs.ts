import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LogEntry } from "@/core/log";

const MAX_ENTRIES = 1000;

const entryKey = (e: LogEntry) => `${e.ts}|${e.event}|${e.message}`;

/** The log history from Rust plus live "log-entry" events. */
export function useLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let loaded = false;
    // Entries that arrive while the initial read is in flight.
    const early: LogEntry[] = [];

    const unlisten = listen<LogEntry>("log-entry", ({ payload }) => {
      if (!loaded) early.push(payload);
      else setEntries((prev) => [...prev.slice(-(MAX_ENTRIES - 1)), payload]);
    });

    void invoke<LogEntry[]>("log_read").then((initial) => {
      if (!alive) return;
      loaded = true;
      const seen = new Set(initial.map(entryKey));
      setEntries([...initial, ...early.filter((e) => !seen.has(entryKey(e)))].slice(-MAX_ENTRIES));
    });
    void invoke<string>("log_path").then((p) => alive && setPath(p));

    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, []);

  const clear = async () => {
    await invoke("log_clear");
    setEntries([]);
  };

  return { entries, path, clear };
}
