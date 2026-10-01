// Light sync, UI side. The engine lives in Rust (src-tauri/src/sync) and keeps
// running while the window is hidden; this module only sends commands and
// mirrors what Rust reports ("sync-status", "sync-preview") for React.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { log } from "@/core/log";
import type {
  AreaDraft,
  AudioDevices,
  AudioSource,
  Monitor,
  MusicStyle,
  SyncOverview,
  SyncStatus,
} from "@/types";

export type SyncRequest = {
  areaId: string;
  mode: "ambient" | "music" | "screen";
  palette: string[];
  intensity: number;
  restore: boolean;
  style?: MusicStyle;
  source?: AudioSource;
  monitor?: string | null;
  safeMode: boolean;
  takeOver?: boolean;
};

/** One "sync-preview" event (~12 per second while streaming). */
type Preview = {
  colors: string[];
  audioLost: boolean;
};

export type SyncState = {
  status: SyncStatus;
  overview: SyncOverview | null;
  loading: boolean;
  /** Loading the overview failed (e.g. bridge unreachable). */
  error: string | null;
  /** Current channel colors while streaming, "#RRGGBB" in channel order. */
  preview: string[];
  /** Music: the audio input is gone for now (sound server restarting, …). */
  audioLost: boolean;
  /** Names for "Sound from"; null until asked or when there's no sound server. */
  audioDevices: AudioDevices | null;
  /** Monitors for screen sync; null until asked or when capture is unavailable. */
  monitors: Monitor[] | null;
};

let state: SyncState = {
  status: { state: "idle" },
  overview: null,
  loading: false,
  error: null,
  preview: [],
  audioLost: false,
  audioDevices: null,
  monitors: null,
};
const listeners = new Set<() => void>();

function patch(partial: Partial<SyncState>): void {
  state = { ...state, ...partial };
  for (const listener of listeners) listener();
}

export function subscribeSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSyncState(): SyncState {
  return state;
}

export const sync = {
  async refresh(): Promise<void> {
    patch({ loading: true });
    try {
      const overview = await invoke<SyncOverview>("sync_overview");
      patch({ overview, status: overview.status, loading: false, error: null });
    } catch (error) {
      patch({ loading: false, error: String(error) });
    }
  },

  /** Cheap (no bridge): called on opening the tab and the "Sound from" list,
   *  so a device switched in the system shows up. */
  async refreshAudioDevices(): Promise<void> {
    const audioDevices = await invoke<AudioDevices>("sync_audio_devices").catch(() => null);
    patch({ audioDevices });
  },

  /** Wayland: the system's sharing dialog now; the choice is kept for the next start. */
  async pickScreen(): Promise<void> {
    try {
      await invoke("sync_screen_pick");
    } finally {
      await sync.refresh();
    }
  },

  async refreshMonitors(): Promise<void> {
    const monitors = await invoke<Monitor[]>("sync_monitors").catch(() => null);
    patch({ monitors });
  },

  async start(request: SyncRequest): Promise<void> {
    // Failures arrive as an "error" status too; the promise only mirrors them.
    await invoke("sync_start", { request }).catch(() => {});
  },

  async stop(): Promise<void> {
    await invoke("sync_stop");
  },

  async createArea(draft: AreaDraft): Promise<string> {
    const id = await invoke<string>("sync_create_area", { draft });
    await sync.refresh();
    return id;
  },

  async updateArea(id: string, draft: AreaDraft): Promise<void> {
    await invoke("sync_update_area", { id, draft });
    await sync.refresh();
  },

  async deleteArea(id: string): Promise<void> {
    await invoke("sync_delete_area", { id });
    await sync.refresh();
  },
};

void listen<SyncStatus>("sync-status", ({ payload }) => {
  const streaming = payload.state === "streaming";
  patch({
    status: payload,
    preview: streaming ? state.preview : [],
    audioLost: streaming && state.audioLost,
  });
  // Area "active" flags change with the stream; keep the overview honest.
  if (payload.state === "idle" || payload.state === "streaming") void sync.refresh();
});

void listen<Preview>("sync-preview", ({ payload }) =>
  patch({ preview: payload.colors, audioLost: payload.audioLost }),
);

void invoke<SyncStatus>("sync_status")
  .then((status) => patch({ status }))
  .catch((error) => log.warn("app", "sync.status_failed", String(error)));
