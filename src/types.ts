// Data model shared by the core, the tray sync and the React UI.

import type { Gamut, Rgb, Xy } from "@/lib/color";

export type BridgeCandidate = {
  id: string;
  ip: string;
  /** "mdns" | "cloud" | "manual" — where it came from, shown in the UI */
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
  /** What the light can do — from the CLIP v2 resource, not the model name.
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
  /** the room's grouped_light service — one command for the whole room */
  groupedLightId: string | null;
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
  /** Returns ok:false with a message when the bridge button was not pressed. */
  pair(ip: string): Promise<Result>;
  forget(): Promise<Result>;
  reconnect(): Promise<void>;
  setRoom(command: LightCommand): Promise<Result>;
  setLight(command: LightCommand): Promise<Result>;
  setAllRooms(on: boolean): void;
  rememberColor(lightId: string, hex: string): Promise<void>;
  saveScene(roomId: string, name: string): Promise<void>;
  deleteScene(sceneId: string): Promise<void>;
  applyScene(scene: Scene): void;
  applyPalette(roomId: string, palette: Palette): void;
  setPreferences(patch: Partial<Preferences>): Promise<void>;
  minimize(): Promise<void>;
  hideToTray(): Promise<void>;
  quit(): Promise<void>;
};
