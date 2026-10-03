// Core: Hue state, bridge connection, preferences - independent of React.
//
// The logic lives in the single webview. The window is never destroyed - the
// close button hides it or quits, depending on the user's choice (see
// on_window_event in src-tauri/src/lib.rs and requestClose in App.tsx).
//
// The tray is owned by Rust (src-tauri/src/tray.rs), not by this code:
// WebKitGTK suspends JS in a hidden window, so menu clicks routed through JS
// would do nothing while the app sits in the tray. We only push state to it
// via `set_tray_state`, and Rust handles its menu natively. The bridge
// transport (pinned TLS, SSE) is on the Rust side as well.
//
// React reads this module through `subscribe` / `getState`
// (useSyncExternalStore). `state` is replaced, never mutated.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { log } from "@/core/log";
import { locale, t } from "@/i18n";
import {
  discoverBridges,
  HueClient,
  LINK_WAIT_MS,
  PairTimedOut,
  pairWhenPressed,
  type HueResource,
} from "@/hue/client";
import {
  applyEvent,
  commandToResource,
  fetchSnapshot,
  toHueView,
  type Snapshot,
} from "@/hue/model";
import { captureScene, paletteCommands, pushHistory, sceneCommands } from "@/lib/presets";
import { CommandQueue } from "@/queue";
import { DEFAULT_SETTINGS, loadSettings, NO_BRIDGE, saveSettings, type Settings } from "@/store";
import type { Actions, AppState, Library, LightCommand, Preferences, Result } from "@/types";

// --- State -------------------------------------------------------------------

let settings: Settings = { ...DEFAULT_SETTINGS };
let client: HueClient | null = null;
let snapshot: Snapshot | null = null;
let unsubscribe: (() => void) | null = null;

/** Reconnect after a failed connect - one transient bridge error (an overload
 *  page, a Wi-Fi hiccup) must not leave the app stuck until restart. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_MIN_MS;

function preferencesOf(s: Settings): Preferences {
  return {
    closeBehavior: s.closeBehavior,
    theme: s.theme,
    checkForUpdates: s.checkForUpdates,
    dismissedUpdate: s.dismissedUpdate,
  };
}

let state: AppState = {
  status: "connecting",
  error: null,
  rooms: [],
  lights: [],
  bridge: null,
  preferences: preferencesOf(DEFAULT_SETTINGS),
  syncing: { rooms: [], lights: [] },
  library: DEFAULT_SETTINGS.library,
  syncPrefs: DEFAULT_SETTINGS.syncPrefs,
  scheduleLocation: null,
};

const listeners = new Set<() => void>();

const queue = new CommandQueue(
  { light: 100, group: 1000 },
  (error, key, payload) => {
    log.error("command", "command.failed", `${describeKey(key)}: ${describe(error)}`, {
      key,
      payload,
    });
  },
  () => recomputeSync(),
);

const appWindow = getCurrentWindow();

// --- Store API ---------------------------------------------------------------

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live bridge connection, for other core modules (schedules). */
export function hueClient(): HueClient | null {
  return client;
}

export function getState(): AppState {
  return state;
}

export const actions: Actions = {
  discover: () => discoverBridges(),

  pair: async (ip, signal) => {
    log.info("pairing", "pair.waiting", `Waiting for the link button on ${ip}`, {
      ip,
      seconds: LINK_WAIT_MS / 1000,
    });
    try {
      const result = await pairWhenPressed(ip, signal);
      if (!result) {
        log.info("pairing", "pair.cancelled", `Pairing with ${ip} was cancelled`);
        return { ok: false };
      }
      settings = {
        ...settings,
        bridgeIp: ip,
        bridgeId: null,
        applicationKey: result.applicationKey,
        clientKey: result.clientKey,
        certFingerprint: result.certFingerprint,
      };
      await saveSettings(settings);
      log.info("pairing", "pair.ok", `Paired with the bridge at ${ip}`, {
        fingerprint: result.certFingerprint,
      });
      await connect();
      return { ok: true };
    } catch (error) {
      log.warn("pairing", "pair.failed", `Pairing with ${ip} failed: ${describe(error)}`, {
        ip,
        reason: error instanceof PairTimedOut ? "timeout" : "error",
      });
      return { ok: false, error: describe(error) };
    }
  },

  forget: async () => {
    log.info("app", "bridge.forget", `Forgot the bridge at ${settings.bridgeIp ?? "?"}`);
    disconnect();
    // Only the pairing is forgotten - preferences stay.
    settings = { ...settings, ...NO_BRIDGE };
    await saveSettings(settings);
    patchState({ status: "unconfigured", error: null, rooms: [], lights: [], bridge: null });
    return { ok: true };
  },

  reconnect: () => {
    log.info("bridge", "connect.manual", "Reconnect requested by the user");
    return connect();
  },

  setRoom: async (command) => applyRoomCommand(command),
  setLight: async (command) => applyLightCommand(command),

  setAllRooms: (on) => {
    log.info("command", "command.user", `All rooms ${on ? "on" : "off"}`, {
      origin: "ui",
      rooms: state.rooms.map((r) => r.name),
      on,
    });
    for (const room of state.rooms) void applyRoomCommand({ id: room.id, on }, { silent: true });
  },

  rememberColor: async (lightId, hex) => {
    const history = pushHistory(state.library.colorHistory[lightId] ?? [], hex);
    log.debug("ui", "color.history", `Color ${hex} added to the history`, { lightId, history });
    await updateLibrary({
      ...state.library,
      colorHistory: { ...state.library.colorHistory, [lightId]: history },
    });
  },

  saveScene: async (roomId, name) => {
    const lights = state.lights.filter((l) => l.roomId === roomId);
    const scene = {
      id: crypto.randomUUID(),
      name,
      roomId,
      createdAt: Date.now(),
      lights: captureScene(lights),
    };
    log.info("command", "preset.saved", `Preset "${name}" saved`, {
      room: state.rooms.find((r) => r.id === roomId)?.name,
      lights: lights.length,
    });
    await updateLibrary({ ...state.library, scenes: [scene, ...state.library.scenes] });
  },

  updateScene: async (sceneId, { name, recapture }) => {
    const scene = state.library.scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    // Same place in the list, same id: an edit, not a new preset.
    const updated = {
      ...scene,
      name,
      ...(recapture ? { lights: captureScene(state.lights.filter((l) => l.roomId === scene.roomId)) } : {}),
    };
    log.info("command", "preset.updated", `Preset "${scene.name}" updated`, {
      renamed: name !== scene.name ? name : undefined,
      recaptured: recapture,
    });
    await updateLibrary({
      ...state.library,
      scenes: state.library.scenes.map((s) => (s.id === sceneId ? updated : s)),
    });
  },

  deleteScene: async (sceneId) => {
    const scene = state.library.scenes.find((s) => s.id === sceneId);
    log.info("command", "preset.deleted", `Preset "${scene?.name ?? sceneId}" deleted`);
    await updateLibrary({
      ...state.library,
      scenes: state.library.scenes.filter((s) => s.id !== sceneId),
    });
  },

  applyScene: (scene) => {
    const commands = sceneCommands(scene, state.lights);
    log.info("command", "preset.applied", `Preset "${scene.name}" applied`, {
      origin: "ui",
      lights: commands.length,
    });
    for (const command of commands) void applyLightCommand(command, { silent: true });
  },

  applyPalette: (roomId, palette) => {
    const commands = paletteCommands(
      palette,
      state.lights.filter((l) => l.roomId === roomId),
    );
    log.info("command", "palette.applied", `Palette "${palette.id}" applied`, {
      origin: "ui",
      room: state.rooms.find((r) => r.id === roomId)?.name,
      lights: commands.length,
    });
    for (const command of commands) void applyLightCommand(command, { silent: true });
  },

  setPreferences: async (patch) => {
    log.info(
      "app",
      "prefs.changed",
      `Preferences changed: ${Object.keys(patch).join(", ")}`,
      patch,
    );
    settings = { ...settings, ...patch };
    patchState({ preferences: { ...state.preferences, ...patch } });
    await saveSettings(settings);
  },

  setScheduleLocation: async (location) => {
    settings = { ...settings, scheduleLocation: location };
    patchState({ scheduleLocation: location });
    await saveSettings(settings);
  },

  setSyncPrefs: async (patch) => {
    const next = { ...state.syncPrefs, ...patch };
    settings = { ...settings, syncPrefs: next };
    patchState({ syncPrefs: next });
    await saveSettings(settings);
  },

  minimize: () => appWindow.minimize(),
  // Rust remembers the position on hide and restores it on show (window.rs).
  hideToTray: () => invoke("window_hide"),
  quit: async () => {
    log.info("app", "app.quit", "Quit from the window");
    // Let the logger flush before the process goes away.
    await new Promise((r) => setTimeout(r, 300));
    await invoke("quit");
  },
};

// --- Window ------------------------------------------------------------------

async function showWindow(): Promise<void> {
  await invoke("window_show");
}

// --- Tray --------------------------------------------------------------------

/** Pushes the part of the state the tray menu needs. Rust skips rebuilding
 *  the menu when nothing changed, so calling this on every publish is fine. */
function syncTray(): void {
  void invoke("set_tray_state", {
    model: {
      status: state.status,
      error: state.error,
      rooms: state.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        on: r.on,
        groupedLightId: r.groupedLightId,
      })),
    },
  }).catch((error) => log.error("tray", "tray.sync_failed", describe(error)));
}

// --- Commands ----------------------------------------------------------------

function toHuePayload(command: LightCommand): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (command.on !== undefined) payload.on = { on: command.on };
  if (command.brightness !== undefined) {
    payload.dimming = { brightness: clamp(command.brightness, 0, 100) };
  }
  if (command.mirek !== undefined) {
    payload.color_temperature = { mirek: Math.round(command.mirek) };
  }
  if (command.xy !== undefined) payload.color = { xy: command.xy };
  return payload;
}

/** Toggles are logged as user actions here; slider moves are logged once on
 *  release by the UI (every step would flood the log). */
function logToggle(kind: "room" | "light", name: string, command: LightCommand): void {
  if (
    command.on === undefined ||
    command.brightness !== undefined ||
    command.mirek !== undefined ||
    command.xy !== undefined
  ) {
    return;
  }
  log.info("command", "command.user", `${name}: turn ${command.on ? "on" : "off"}`, {
    origin: "ui",
    [kind]: { id: command.id, name },
    on: command.on,
  });
}

/** Wraps a bridge call: timing, logging, and the timestamp sync tracking needs. */
function sender(
  resource: "grouped_light" | "light",
  id: string,
  label: string,
  roomId: string | null,
) {
  return async (payload: Record<string, unknown>) => {
    if (!client) throw new Error(t("error.no_connection"));
    if (roomId) lastSendAt.set(roomId, Date.now());
    const started = performance.now();
    await client.update(resource, id, payload);
    log.debug("command", "command.sent", `${label}: ${JSON.stringify(payload)}`, {
      resource,
      id,
      payload,
      ms: Math.round(performance.now() - started),
    });
  };
}

async function applyRoomCommand(command: LightCommand, { silent = false } = {}): Promise<Result> {
  const room = state.rooms.find((r) => r.id === command.id);
  if (!client || !room?.groupedLightId) return { ok: false, error: t("error.room_unavailable") };
  if (!silent) logToggle("room", room.name, command);

  // Optimistic update: the eventstream will deliver the truth shortly,
  // but the UI should react immediately.
  applyLocally(commandToResource("grouped_light", room.groupedLightId, command));

  queue.enqueue(
    "group",
    `group:${room.groupedLightId}`,
    toHuePayload(command),
    sender("grouped_light", room.groupedLightId, room.name, room.id),
  );
  return { ok: true };
}

async function applyLightCommand(command: LightCommand, { silent = false } = {}): Promise<Result> {
  if (!client) return { ok: false, error: t("error.no_connection") };
  const light = state.lights.find((l) => l.id === command.id);
  const name = light?.name ?? command.id;
  if (!silent) logToggle("light", name, command);

  // Optimistic: the light's color, its room's color, the gradient and the
  // current preset all follow at once, without waiting for the bridge.
  applyLocally(commandToResource("light", command.id, command));

  queue.enqueue(
    "light",
    `light:${command.id}`,
    toHuePayload(command),
    sender("light", command.id, name, light?.roomId ?? null),
  );
  return { ok: true };
}

// --- Sync indicator ----------------------------------------------------------
//
// A room is "syncing" while a command for it or one of its lights is queued or
// in flight, and after that until the bridge reports the room's new aggregate
// (a grouped_light event) - that event is what moves the room slider after a
// light slider was dragged. SYNC_EVENT_TIMEOUT_MS caps the wait, since no
// event comes when nothing actually changed.

const SYNC_EVENT_TIMEOUT_MS = 2_500;
/** Rooms busy on the previous recompute - to detect the busy -> idle edge. */
const busyRooms = new Set<string>();
/** roomId -> time we stop waiting for its grouped_light event */
const awaitingEvent = new Map<string, number>();
/** roomId -> when the last command touching it started / its last group event */
const lastSendAt = new Map<string, number>();
const lastGroupEventAt = new Map<string, number>();
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function recomputeSync(): void {
  const now = Date.now();
  const lights = state.lights.filter((l) => queue.isBusy(`light:${l.id}`)).map((l) => l.id);
  const rooms: string[] = [];
  let nextDeadline = Infinity;

  for (const room of state.rooms) {
    const busy =
      (room.groupedLightId !== null && queue.isBusy(`group:${room.groupedLightId}`)) ||
      room.lightIds.some((id) => queue.isBusy(`light:${id}`));

    if (busy) {
      busyRooms.add(room.id);
      rooms.push(room.id);
      continue;
    }

    if (busyRooms.delete(room.id)) {
      // Just went idle: wait for the bridge's aggregate unless it already
      // arrived after our last command started.
      const eventAt = lastGroupEventAt.get(room.id) ?? 0;
      if (eventAt < (lastSendAt.get(room.id) ?? 0)) {
        awaitingEvent.set(room.id, now + SYNC_EVENT_TIMEOUT_MS);
      }
    }

    const deadline = awaitingEvent.get(room.id);
    if (deadline === undefined) continue;
    if (deadline > now) {
      rooms.push(room.id);
      nextDeadline = Math.min(nextDeadline, deadline);
    } else {
      awaitingEvent.delete(room.id);
    }
  }

  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = Number.isFinite(nextDeadline)
    ? setTimeout(recomputeSync, nextDeadline - now + 10)
    : null;

  if (!sameIds(rooms, state.syncing.rooms) || !sameIds(lights, state.syncing.lights)) {
    patchState({ syncing: { rooms, lights } });
  }
}

function onGroupedLightEvent(groupedLightId: string): void {
  const room = state.rooms.find((r) => r.groupedLightId === groupedLightId);
  if (!room) return;
  lastGroupEventAt.set(room.id, Date.now());
  if (awaitingEvent.delete(room.id)) recomputeSync();
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// --- Connection --------------------------------------------------------------

function disconnect(): void {
  cancelRetry();
  unsubscribe?.();
  unsubscribe = null;
  client = null;
  snapshot = null;
}

async function connect({ retry = false } = {}): Promise<void> {
  cancelRetry();
  unsubscribe?.();
  unsubscribe = null;

  if (!settings.bridgeIp || !settings.applicationKey) {
    patchState({ status: "unconfigured", error: null, rooms: [], lights: [], bridge: null });
    return;
  }

  // A background retry keeps the current error on screen instead of flashing
  // "connecting" (and wiping what the user typed on the pairing screen).
  if (!retry) {
    patchState({ status: "connecting", error: null, bridge: basicBridgeInfo() });
  }

  const started = performance.now();
  log.info(
    "bridge",
    "connect.start",
    `Connecting to ${settings.bridgeIp}${retry ? " (retry)" : ""}`,
    {
      ip: settings.bridgeIp,
      pinned: Boolean(settings.certFingerprint),
    },
  );

  try {
    client = new HueClient(settings);
    snapshot = await fetchSnapshot(client);

    // First successful contact - store the certificate fingerprint (TOFU).
    if (!settings.certFingerprint && client.seenFingerprint) {
      settings = { ...settings, certFingerprint: client.seenFingerprint };
      await saveSettings(settings);
      log.info("bridge", "tls.pinned", "Bridge certificate pinned on first use", {
        fingerprint: client.seenFingerprint,
      });
    }

    retryDelay = RETRY_MIN_MS;
    publishSnapshot();
    log.info("bridge", "connect.ok", `Connected in ${Math.round(performance.now() - started)} ms`, {
      rooms: state.rooms.length,
      lights: state.lights.length,
      unreachable: state.lights.filter((l) => !l.reachable).map((l) => l.name),
      devices: snapshot.devices.size,
      bridge: { model: state.bridge?.modelId, firmware: state.bridge?.softwareVersion },
    });

    unsubscribe = client.subscribe(
      (events) => {
        if (!snapshot) return;
        let dirty = false;
        const types: Record<string, number> = {};
        const groupEvents: string[] = [];
        for (const event of events) {
          if (event.type !== "update" && event.type !== "add") continue;
          for (const resource of event.data) {
            types[resource.type] = (types[resource.type] ?? 0) + 1;
            if (resource.type === "grouped_light") groupEvents.push(resource.id);
            if (applyEvent(snapshot, resource)) dirty = true;
          }
        }
        log.debug("bridge", "stream.events", `Bridge update: ${formatCounts(types)}`, types);
        if (dirty) publishSnapshot();
        for (const id of groupEvents) onGroupedLightEvent(id);
      },
      (ok) => {
        if (!ok && state.status === "ready") {
          patchState({ status: "connecting" });
        } else if (ok && state.status !== "ready" && snapshot) {
          publishSnapshot();
        }
      },
    );
  } catch (error) {
    patchState({ status: "error", error: describe(error) });
    log.error("bridge", "connect.failed", describe(error), {
      ip: settings.bridgeIp,
      ms: Math.round(performance.now() - started),
      retryInSeconds: retryDelay / 1000,
    });
    retryTimer = setTimeout(() => void connect({ retry: true }), retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }
}

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Bridge details known before the first successful connection. */
function basicBridgeInfo(): AppState["bridge"] {
  if (!settings.bridgeIp) return null;
  return {
    name: state.bridge?.name ?? null,
    bridgeId: state.bridge?.bridgeId ?? null,
    ip: settings.bridgeIp,
    modelId: state.bridge?.modelId ?? null,
    softwareVersion: state.bridge?.softwareVersion ?? null,
    timeZone: state.bridge?.timeZone ?? null,
    fingerprint: settings.certFingerprint,
  };
}

// --- Library -----------------------------------------------------------------

function updateLibrary(next: Library): Promise<void> {
  settings = { ...settings, library: next };
  patchState({ library: next });
  return saveSettings(settings);
}

// --- Publishing state --------------------------------------------------------

/**
 * Optimistic update through the snapshot, exactly like a bridge event. Keeping
 * predictions out of the snapshot (patching only `state`) made every partial
 * event roll other pending lights back for a moment - e.g. the current-preset
 * border blinking after applying a preset.
 */
function applyLocally(resource: HueResource): void {
  if (!snapshot) return;
  applyEvent(snapshot, resource);
  publishSnapshot();
}

function publishSnapshot(): void {
  if (!snapshot || !settings.bridgeIp) return;
  const view = toHueView(snapshot, {
    ip: settings.bridgeIp,
    fingerprint: settings.certFingerprint,
  });
  patchState({ status: "ready", error: null, ...view });
}

function patchState(partial: Partial<AppState>): void {
  state = { ...state, ...partial };
  syncTray();
  for (const listener of listeners) listener();
}

// --- Helpers -----------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function describe(error: unknown): string {
  // Errors from Rust commands arrive as plain strings.
  return error instanceof Error ? error.message : String(error);
}

/** "group:<id>" / "light:<id>" -> a readable name for log messages. */
function describeKey(key: string): string {
  const [kind, id] = key.split(":");
  if (kind === "light") return state.lights.find((l) => l.id === id)?.name ?? key;
  return state.rooms.find((r) => r.groupedLightId === id)?.name ?? key;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([type, n]) => `${n}× ${type}`)
    .join(", ");
}

// --- Start -------------------------------------------------------------------

/** Rust already sent the command to the bridge; mirror it in our state. */
void listen<{ id: string; on: boolean }>("tray-room-changed", ({ payload }) => {
  const room = state.rooms.find((r) => r.id === payload.id);
  if (room?.groupedLightId) {
    applyLocally(
      commandToResource("grouped_light", room.groupedLightId, { id: room.id, on: payload.on }),
    );
  }
});

export async function start(): Promise<void> {
  try {
    settings = await loadSettings();
    log.info("app", "app.start", `HueFL ${await getVersion()} started`, {
      userAgent: navigator.userAgent,
      locale,
      paired: Boolean(settings.applicationKey),
      bridgeIp: settings.bridgeIp,
      preferences: preferencesOf(settings),
    });
    patchState({
      status: settings.applicationKey ? "connecting" : "unconfigured",
      bridge: basicBridgeInfo(),
      preferences: preferencesOf(settings),
      library: settings.library,
      syncPrefs: settings.syncPrefs,
      scheduleLocation: settings.scheduleLocation,
    });

    // The app starts in its window, centered (tauri.conf.json). It is created
    // hidden and shown here, once the UI can paint - no blank flash.
    await showWindow();

    await connect();
  } catch (error) {
    log.error("app", "app.start_failed", describe(error), { error });
    // Make the failure visible instead of sitting silently in the tray.
    patchState({ status: "error", error: describe(error) });
    void showWindow();
  }
}
