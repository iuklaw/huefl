// Persistent settings: bridge pairing plus user preferences.
// The file follows XDG (~/.config/huefl/config.json, mode 600). Reading and
// writing happen on the Rust side (src-tauri/src/config.rs), because the
// webview has no file system access. Rust reads the bridge fields too (the
// tray talks to the bridge on its own) and ignores the rest.
import { invoke } from "@tauri-apps/api/core";
import { sanitizeTuning, tuningForAll } from "./lib/tuning";
import type { CloseBehavior, Library, ScheduleLocation, SyncPrefs, ThemePreference } from "./types";

export type BridgePairing = {
  bridgeIp: string | null;
  bridgeId: string | null;
  applicationKey: string | null;
  /** Entertainment API (DTLS) key. Unused here, but the bridge hands it out for free. */
  clientKey: string | null;
  /** SHA-256 of the bridge certificate, stored on first connection (TOFU). */
  certFingerprint: string | null;
};

export type Settings = BridgePairing & {
  closeBehavior: CloseBehavior;
  theme: ThemePreference;
  checkForUpdates: boolean;
  dismissedUpdate: string | null;
  startAtLogin: boolean;
  /** Color history and saved presets. */
  library: Library;
  syncPrefs: SyncPrefs;
  /** For sunrise / sunset schedules; null = from the bridge's time zone. */
  scheduleLocation: ScheduleLocation | null;
};

export const NO_BRIDGE: BridgePairing = {
  bridgeIp: null,
  bridgeId: null,
  applicationKey: null,
  clientKey: null,
  certFingerprint: null,
};

export const DEFAULT_SETTINGS: Settings = {
  ...NO_BRIDGE,
  closeBehavior: "ask",
  theme: "system",
  checkForUpdates: true,
  dismissedUpdate: null,
  startAtLogin: false,
  library: { colorHistory: {}, scenes: [] },
  syncPrefs: {
    areaId: null,
    mode: "ambient",
    colorsFrom: "palette:sunset",
    tuning: tuningForAll(1),
    advancedOpen: false,
    restore: true,
    musicStyle: "pulse",
    audioSource: "system",
    safeMode: true,
    screenMonitor: null,
  },
  scheduleLocation: null,
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await invoke<string | null>("load_config");
    if (!raw) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      library: { ...DEFAULT_SETTINGS.library, ...saved.library },
      syncPrefs: sanitizeSyncPrefs(saved.syncPrefs),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Values from older versions that no longer exist fall back to defaults.
 *  Before per-mode settings there was one `intensity`; every mode starts from it. */
function sanitizeSyncPrefs(saved: Partial<SyncPrefs> & { intensity?: unknown } = {}): SyncPrefs {
  const { intensity, tuning, ...rest } = saved;
  const prefs = { ...DEFAULT_SETTINGS.syncPrefs, ...rest };
  const styles: SyncPrefs["musicStyle"][] = ["pulse", "spectrum"];
  return {
    ...prefs,
    musicStyle: styles.includes(prefs.musicStyle) ? prefs.musicStyle : "pulse",
    tuning: sanitizeTuning(tuning, intensity),
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("save_config", { contents: JSON.stringify(settings, null, 2) });
}
