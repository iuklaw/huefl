// New versions, UI side. Rust does the checking, downloading and installing
// (src-tauri/src/updates.rs, the official updater plugin with signed
// releases); this keeps the state for the title bar's badge, the update
// dialog and Options → About, and checks now and then - unless updates come
// from Flathub or a package manager (`update_channel`).

import { useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { actions, getState, subscribe as subscribeApp } from "@/core/app";
import { log } from "@/core/log";

export type UpdateInfo = {
  version: string;
  current: string;
  notes: string | null;
  /** RFC 3339 */
  date: string | null;
};

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "upToDate" }
  | { status: "available"; info: UpdateInfo }
  | { status: "downloading"; info: UpdateInfo; downloaded: number; total: number | null }
  | { status: "ready"; info: UpdateInfo }
  | { status: "error"; info: UpdateInfo | null; message: string }
  /** This build has no release key / address yet. */
  | { status: "unavailable" }
  /** Updates come from elsewhere; the app doesn't look for them. */
  | { status: "managed"; by: "flathub" | "package" };

/** Rust's UpdateChannel. */
type UpdateChannel = "app" | "flathub" | "package";

let state: UpdateState = { status: "idle" };
const listeners = new Set<() => void>();

function set(next: UpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useUpdates(): UpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** The version the title bar should point at, unless the user said "Later" to it. */
export function badgeVersion(update: UpdateState, dismissed: string | null): string | null {
  if (update.status === "downloading" || update.status === "ready") return update.info.version;
  if (update.status === "available" && update.info.version !== dismissed) return update.info.version;
  return null;
}

const FIRST_CHECK_MS = 10_000;
const EVERY_MS = 6 * 3_600_000;

export const updates = {
  /** `manual`: from "Check for updates" - shows "up to date" or the error. */
  async check(manual = false): Promise<void> {
    if (["checking", "downloading", "ready", "managed"].includes(state.status)) return;
    if (manual) set({ status: "checking" });
    try {
      const info = await invoke<UpdateInfo | null>("update_check");
      set(info ? { status: "available", info } : manual ? { status: "upToDate" } : { status: "idle" });
    } catch (error) {
      // Offline or the release server is down: only worth saying when asked.
      if (!manual) set({ status: "idle" });
      else if (String(error) === "not_configured") set({ status: "unavailable" });
      else set({ status: "error", info: null, message: String(error) });
    }
  },

  async install(): Promise<void> {
    // From the offer, or retrying after a failed install.
    if (state.status !== "available" && state.status !== "error") return;
    const info = state.info;
    if (!info) return;
    set({ status: "downloading", info, downloaded: 0, total: null });
    const onProgress = new Channel<{ downloaded: number; total: number | null }>();
    onProgress.onmessage = ({ downloaded, total }) => {
      if (state.status === "downloading") set({ ...state, downloaded, total });
    };
    try {
      await invoke("update_install", { onProgress });
      set({ status: "ready", info });
    } catch (error) {
      log.warn("ui", "update.install_failed", String(error));
      set({ status: "error", info, message: String(error) });
    }
  },

  /** Into the new version (sync is stopped and the lights restored first). */
  restart(): Promise<void> {
    return invoke("update_restart");
  },

  /** "Later": no badge for this version; a newer one shows again. */
  async later(): Promise<void> {
    if (state.status === "available") await actions.setPreferences({ dismissedUpdate: state.info.version });
  },
};

// Automatic checks: shortly after start, then every few hours - if enabled
// and this copy updates itself.
let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (getState().preferences.checkForUpdates) void updates.check();
    schedule(EVERY_MS);
  }, delay);
}
void invoke<UpdateChannel>("update_channel")
  .catch(() => "app" as const)
  .then((channel) => {
    if (channel === "app") schedule(FIRST_CHECK_MS);
    else set({ status: "managed", by: channel });
  });

// Turning the setting on checks right away.
let wasOn = getState().preferences.checkForUpdates;
subscribeApp(() => {
  const on = getState().preferences.checkForUpdates;
  if (on && !wasOn) void updates.check();
  wasOn = on;
});
