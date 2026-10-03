// Data model shared by the core, the tray sync and the React UI.

import type { Gamut, Rgb, Xy } from "@/lib/color";

export type BridgeCandidate = {
  id: string;
  ip: string;
  /** "mdns" | "cloud" | "manual" - where it came from, shown in the UI */
  source: string;
};

/** From the device resource's product_data. */
export type ProductInfo = {
  name: string | null;
  modelId: string | null;
  softwareVersion: string | null;
};

export type LightView = {
  id: string;
  name: string;
  roomId: string | null;
  on: boolean;
  /** 0..100, same as CLIP v2 */
  brightness: number;
  /** What the light can do - from the CLIP v2 resource, not the model name.
   *  A smart plug has none of these. */
  capabilities: { dimming: boolean; temperature: boolean; color: boolean };
  /** color temperature in mireds; null when unsupported or in color (xy) mode */
  mirek: number | null;
  mirekRange: { min: number; max: number } | null;
  /** Current color at full brightness, whatever the mode; null for plugs. */
  color: Rgb | null;
  /** Current CIE xy, for color lights */
  xy: Xy | null;
  gamut: Gamut | null;
  reachable: boolean;
  product: ProductInfo | null;
};

export type RoomView = {
  id: string;
  name: string;
  /** the room's grouped_light service - one command for the whole room */
  groupedLightId: string | null;
  /** The same room as an API v1 group ("81"), which bridge schedules address. */
  v1GroupId: string | null;
  on: boolean;
  brightness: number;
  lightIds: string[];
  /** Brightness-weighted average of the lights that are on; null when all are off. */
  color: Rgb | null;
};

export type BridgeInfo = {
  name: string | null;
  bridgeId: string | null;
  ip: string;
  modelId: string | null;
  softwareVersion: string | null;
  timeZone: string | null;
  fingerprint: string | null;
};

export type CloseBehavior = "ask" | "tray" | "quit";
export type ThemePreference = "system" | "dark" | "light";

export type Preferences = {
  closeBehavior: CloseBehavior;
  theme: ThemePreference;
  /** Look for new versions on GitHub every few hours. */
  checkForUpdates: boolean;
  /** "Later" on this version: no badge until a newer one. */
  dismissedUpdate: string | null;
};

/** One light's state inside a saved scene. Plugs only have `on`. */
export type SceneLightState = { on: boolean; brightness?: number; xy?: Xy; mirek?: number };

/** A saved look of one room: every light's state, restored 1:1. */
export type Scene = {
  id: string;
  name: string;
  roomId: string;
  createdAt: number;
  lights: Record<string, SceneLightState>;
};

/** A ready-made preset: colors spread over the room's lights, or one white. */
export type Palette = {
  id: string;
  brightness: number;
  colors?: string[];
  mirek?: number;
};

/** Where the sun is watched from, for sunrise / sunset schedules. */
export type ScheduleLocation = {
  lat: number;
  lon: number;
  /** IANA time zone of the place. */
  timeZone: string;
  /** "Warsaw, Poland" - for display. */
  name: string;
};

/** The user's saved things, persisted with the settings. */
export type Library = {
  /** lightId -> recently used colors (hex, newest first, max 5) */
  colorHistory: Record<string, string[]>;
  scenes: Scene[];
};

export type AppState = {
  status: "unconfigured" | "connecting" | "ready" | "error";
  error: string | null;
  rooms: RoomView[];
  lights: LightView[];
  /** Known once connected; basic fields (IP) are filled from settings earlier. */
  bridge: BridgeInfo | null;
  preferences: Preferences;
  /** Rooms / lights with commands not yet confirmed by the bridge. */
  syncing: { rooms: string[]; lights: string[] };
  library: Library;
  syncPrefs: SyncPrefs;
  /** Chosen by the user; null = derived from the bridge's time zone. */
  scheduleLocation: ScheduleLocation | null;
};

export type LightCommand = {
  id: string;
  on?: boolean;
  brightness?: number;
  mirek?: number;
  xy?: Xy;
};

export type Result = { ok: boolean; error?: string };

/** Everything the UI can ask the core to do. */
export type Actions = {
  discover(): Promise<BridgeCandidate[]>;
  /** Waits up to LINK_WAIT_MS for the bridge button. Returns ok:false with a
   *  message on failure, and without one when `signal` aborted. */
  pair(ip: string, signal: AbortSignal): Promise<Result>;
  forget(): Promise<Result>;
  reconnect(): Promise<void>;
  setRoom(command: LightCommand): Promise<Result>;
  setLight(command: LightCommand): Promise<Result>;
  setAllRooms(on: boolean): void;
  rememberColor(lightId: string, hex: string): Promise<void>;
  saveScene(roomId: string, name: string): Promise<void>;
  /** Renames a saved scene; `recapture` also replaces its lights with how they look now. */
  updateScene(sceneId: string, patch: { name: string; recapture: boolean }): Promise<void>;
  deleteScene(sceneId: string): Promise<void>;
  applyScene(scene: Scene): void;
  applyPalette(roomId: string, palette: Palette): void;
  setSyncPrefs(patch: Partial<SyncPrefs>): Promise<void>;
  setScheduleLocation(location: ScheduleLocation): Promise<void>;
  setPreferences(patch: Partial<Preferences>): Promise<void>;
  minimize(): Promise<void>;
  hideToTray(): Promise<void>;
  quit(): Promise<void>;
};

// --- Light sync (mirrors src-tauri/src/sync) ---------------------------------

export type SyncStatus =
  | { state: "idle" }
  | { state: "starting"; areaId: string }
  | { state: "streaming"; areaId: string; lightIds: string[] }
  | { state: "stopping" }
  | { state: "error"; code: string; message: string };

export type Position3 = { x: number; y: number; z: number };

export type SyncArea = {
  id: string;
  name: string;
  /** "screen" | "monitor" | "music" | "3dspace" | "other" */
  kind: string;
  /** "active" while someone streams to it */
  status: string;
  channels: { channelId: number; position: Position3 }[];
  lightIds: string[];
  members: { serviceId: string; position: Position3 }[];
};

export type SyncLight = { lightId: string; serviceId: string | null; renderer: boolean };

export type ReadinessCheck = {
  id: "bridge" | "firmware" | "client_key" | "lights" | "area" | "bridge_free" | "audio" | "screen";
  level: "ok" | "warning" | "blocking";
  params?: Record<string, string>;
};

export type SyncOverview = {
  checks: ReadinessCheck[];
  ready: boolean;
  areas: SyncArea[];
  lights: SyncLight[];
  status: SyncStatus;
  /** False in builds without audio support: music mode is off. */
  audioSupported: boolean;
  /** False on Wayland, without a display, or in builds without screen support. */
  screenSupported: boolean;
  /** Wayland: the screen is picked in the system's sharing dialog, not from a list. */
  screenPortal: boolean;
  /** Wayland: the screen the system shares without asking; null = it asks at start. */
  sharedScreen: { width: number; height: number } | null;
};

/** A monitor for screen sync (X11 RandR). */
export type Monitor = { name: string; width: number; height: number; primary: boolean };

/** Default audio devices as the desktop names them (see sync/audio/devices.rs). */
export type AudioDevices = {
  system: string | null;
  microphone: string | null;
  microphoneBluetooth: boolean;
};

export type SyncMode = "ambient" | "music" | "screen";
export type MusicStyle = "pulse" | "spectrum";
export type AudioSource = "system" | "microphone";

/** Persisted choices for the Sync tab. */
export type SyncPrefs = {
  areaId: string | null;
  mode: SyncMode;
  /** "palette:<id>" or "scene:<id>" */
  colorsFrom: string;
  /** 0 subtle … 3 extreme */
  intensity: number;
  restore: boolean;
  musicStyle: MusicStyle;
  audioSource: AudioSource;
  /** Photosensitivity guard: at most three flashes per second. */
  safeMode: boolean;
  /** Screen sync: RandR monitor name; null = the primary one. */
  screenMonitor: string | null;
};

export type AreaDraft = {
  name: string;
  kind: "music" | "screen" | "monitor";
  members: { serviceId: string; position: Position3 }[];
};
