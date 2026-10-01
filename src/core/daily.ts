// "Color of the day", UI side: asks Rust (src-tauri/src/daily.rs) for the
// color of the user's local day. Rust keeps the day's answer, so after one
// successful fetch it also works offline until midnight; before that, with no
// network, the option is shown as unavailable.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { log } from "@/core/log";

export type DailyState =
  | { status: "loading" }
  | { status: "ready"; date: string; hex: string }
  | { status: "offline" };

let state: DailyState = { status: "loading" };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function set(next: DailyState): void {
  // One log line per change of state, not per check.
  if (next.status !== state.status) {
    if (next.status === "ready") log.info("app", "daily.loaded", `Color of the day: ${next.hex}`);
    if (next.status === "offline") log.info("app", "daily.offline", "Color of the day unavailable (offline?)");
  }
  state = next;
  for (const listener of listeners) listener();
}

/** Today in the user's time zone, YYYY-MM-DD. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Loads today's color unless it's already here; cheap to call often. */
export function refreshDailyColor(): Promise<void> {
  const date = today();
  if (state.status === "ready" && state.date === date) return Promise.resolve();
  inFlight ??= invoke<{ date: string; hex: string }>("color_of_the_day", { date })
    .then((color) => set({ status: "ready", date: color.date, hex: color.hex }))
    .catch(() => set({ status: "offline" }))
    .finally(() => (inFlight = null));
  return inFlight;
}

export function useDailyColor(): DailyState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

// At start, and whenever the window comes back (a new day, or the network
// came back after an offline start).
void refreshDailyColor();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshDailyColor();
});
