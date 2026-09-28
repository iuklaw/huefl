// Persistent settings: bridge pairing plus user preferences.
// The file follows XDG (~/.config/hue-tray/config.json, mode 600). Reading and
// writing happen on the Rust side (src-tauri/src/config.rs), because the
// webview has no file system access. Rust reads the bridge fields too (the
// tray talks to the bridge on its own) and ignores the rest.
import { invoke } from "@tauri-apps/api/core";
import type { CloseBehavior, Library, SyncPrefs, ThemePreference } from "./types";

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
  /** Color history and saved presets. */
  library: Library;
  syncPrefs: SyncPrefs;
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
  library: { colorHistory: {}, scenes: [] },
  syncPrefs: {
    areaId: null,
    mode: "ambient",
    colorsFrom: "palette:sunset",
    intensity: 1,
    restore: true,
    musicStyle: "pulse",
    audioSource: "system",
    safeMode: true,
    screenMonitor: null,
  },
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
      syncPrefs: sanitizeSyncPrefs({ ...DEFAULT_SETTINGS.syncPrefs, ...saved.syncPrefs }),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Values from older versions that no longer exist fall back to defaults. */
function sanitizeSyncPrefs(prefs: SyncPrefs): SyncPrefs {
  const styles: SyncPrefs["musicStyle"][] = ["pulse", "spectrum"];
  return styles.includes(prefs.musicStyle) ? prefs : { ...prefs, musicStyle: "pulse" };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("save_config", { contents: JSON.stringify(settings, null, 2) });
}
