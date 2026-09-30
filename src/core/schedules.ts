// Light schedules, UI side. They live and run on the bridge (see
// hue/schedules.ts); this module mirrors what the bridge has for React and
// sends the changes. Changes to v1 schedules don't come through the event
// stream, so the list is re-read after every change, when a timer is due,
// and every minute while someone is looking.

import { useSyncExternalStore } from "react";
import { actions, getState, hueClient, subscribe as subscribeApp } from "@/core/app";
import { log } from "@/core/log";
import {
  buildRule,
  buildSchedule,
  nextRun,
  parseRules,
  parseSchedules,
  SUN_LEAD,
  type Automation,
  type AutomationDraft,
} from "@/hue/schedules";
import { nextSunEvent } from "@/lib/sun";
import { localTimeZone, zoneOffset } from "@/lib/time";
import { zoneLocation } from "@/lib/zones";
import type { RoomView, ScheduleLocation } from "@/types";

export type TimerMode = "off_in" | "off_for" | "on_in" | "on_for";

export type SchedulesState = {
  automations: Automation[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Bridge clock minus this computer's clock, ms. */
  clockOffset: number;
  /** The bridge's time zone — the one schedules run in. */
  timeZone: string;
  /** The Daylight sensor's id, for sun rules; null if the bridge has none. */
  sensorId: string | null;
  /** The sensor knows our location and flips SUN_LEAD early (see hue/schedules.ts). */
  sensorReady: boolean;
};

// The bridge's Daylight sensor settings for our sun rules.
const SENSOR_OFFSET = -SUN_LEAD;

let state: SchedulesState = {
  automations: [],
  loaded: false,
  loading: false,
  error: null,
  clockOffset: 0,
  timeZone: localTimeZone(),
  sensorId: null,
  sensorReady: false,
};
const listeners = new Set<() => void>();

function patch(partial: Partial<SchedulesState>): void {
  state = { ...state, ...partial };
  for (const listener of listeners) listener();
}

export function subscribeSchedules(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSchedulesState(): SchedulesState {
  return state;
}

export function useSchedules(): SchedulesState {
  return useSyncExternalStore(subscribeSchedules, getSchedulesState);
}

/** Now, by the bridge's clock. */
export function bridgeNow(): number {
  return Date.now() + state.clockOffset;
}

/** Where the sun is watched from: the user's pick, else the bridge time zone's city. */
export function scheduleLocation(): ScheduleLocation {
  return (
    getState().scheduleLocation ??
    zoneLocation(state.timeZone) ??
    zoneLocation(localTimeZone()) ?? { lat: 0, lon: 0, timeZone: "Etc/UTC", name: "UTC" }
  );
}

/** When `automation` runs next (bridge clock, ms); null if it won't. */
export function nextRunOf(automation: Automation, now = bridgeNow()): number | null {
  if (!automation.enabled) return null;
  const trigger = automation.trigger;
  if (trigger.kind === "sun") {
    return nextSunEvent(trigger.event, trigger.offsetMinutes, trigger.days, now, scheduleLocation(), state.timeZone);
  }
  return nextRun(trigger, now, (ms) => zoneOffset(state.timeZone, ms));
}

export function roomOf(automation: Automation): RoomView | undefined {
  return getState().rooms.find((r) => r.v1GroupId === automation.groupId);
}

export function automationsOf(room: RoomView): Automation[] {
  return state.automations.filter((a) => a.groupId === room.v1GroupId);
}

// --- Actions -------------------------------------------------------------------

type V1Config = { UTC?: string; timezone?: string };
type V1Sensor = { type?: string; config?: { configured?: boolean; sunriseoffset?: number; sunsetoffset?: number } };

export const schedules = {
  async refresh(): Promise<void> {
    const client = hueClient();
    if (!client) return;
    patch({ loading: true });
    try {
      const [all, rules, config, sensors] = await Promise.all([
        client.v1<Record<string, never>>("GET", "/schedules"),
        client.v1<Record<string, never>>("GET", "/rules"),
        client.v1<V1Config>("GET", "/config"),
        client.v1<Record<string, V1Sensor>>("GET", "/sensors"),
      ]);
      const bridgeUtc = config.UTC ? Date.parse(`${config.UTC}Z`) : NaN;
      const daylight = Object.entries(sensors).find(([, s]) => s.type === "Daylight");
      const sensor = daylight?.[1].config;
      patch({
        automations: [...parseSchedules(all), ...parseRules(rules)],
        clockOffset: Number.isFinite(bridgeUtc) ? bridgeUtc - Date.now() : 0,
        timeZone: config.timezone || localTimeZone(),
        sensorId: daylight?.[0] ?? null,
        sensorReady:
          sensor?.configured === true &&
          sensor.sunriseoffset === SENSOR_OFFSET &&
          sensor.sunsetoffset === SENSOR_OFFSET,
        loaded: true,
        loading: false,
        error: null,
      });
      planWakeUps();
    } catch (error) {
      patch({ loading: false, error: String(error) });
      log.warn("app", "schedule.load_failed", `Couldn't read schedules: ${error}`);
    }
  },

  /**
   * A countdown on the bridge for a room:
   *   "off_in"   turn off in N min
   *   "off_for"  off now, on after N min
   *   "on_in"    turn on in N min
   *   "on_for"   on now, off after N min
   * A room has one timer at a time: a new one replaces it.
   */
  async startTimer(room: RoomView, minutes: number, mode: TimerMode): Promise<void> {
    await replaceTimer(room);
    if (mode === "on_for" && !room.on) await actions.setRoom({ id: room.id, on: true });
    if (mode === "off_for" && room.on) await actions.setRoom({ id: room.id, on: false });
    await create({
      groupId: room.v1GroupId!,
      name: room.name,
      trigger: { kind: "timer", minutes },
      action: { on: mode === "on_in" || mode === "off_for" },
    });
    log.info("app", "schedule.timer", `${room.name}: ${mode.replace("_", " ")} ${minutes} min`);
  },

  /** Adds minutes to a running timer (the bridge can't: it's recreated). */
  async extendTimer(timer: Automation, minutes: number): Promise<void> {
    const end = nextRunOf(timer);
    if (!end || timer.trigger.kind !== "timer") return;
    const left = Math.max(1, Math.round((end - bridgeNow()) / 60_000));
    await remove(timer);
    await create({ ...timer, trigger: { kind: "timer", minutes: left + minutes } });
  },

  /** Creates a schedule, or replaces `existing` with the draft. */
  async save(draft: AutomationDraft, existing?: Automation): Promise<void> {
    const sameKind = existing && (existing.source === "rule") === (draft.trigger.kind === "sun");
    if (existing && sameKind) {
      await write("PUT", existing, draft);
      log.info("app", "schedule.updated", `Schedule “${draft.name}” updated`);
    } else {
      if (existing) await remove(existing);
      await create(draft);
    }
  },

  async setEnabled(automation: Automation, enabled: boolean): Promise<void> {
    const client = hueClient();
    if (!client) return;
    patch({ automations: state.automations.map((a) => (a === automation ? { ...a, enabled } : a)) });
    await client
      .v1("PUT", `/${path(automation)}/${automation.id}`, { status: enabled ? "enabled" : "disabled" })
      .finally(() => void schedules.refresh());
  },

  async remove(automation: Automation): Promise<void> {
    await remove(automation);
  },

  /**
   * Sets where the sun is watched from — here and on the bridge, which runs
   * the sun rules (its Daylight sensor; the Philips Hue app uses the same
   * location).
   */
  async setLocation(location: ScheduleLocation): Promise<void> {
    await actions.setScheduleLocation(location);
    await configureSensor(location);
    log.info("app", "schedule.location", `Location set to ${location.name}`, {
      lat: location.lat,
      lon: location.lon,
      timeZone: location.timeZone,
    });
  },
};

/** "052.2500N" / "021.0000E", as the v1 Daylight sensor takes coordinates. */
function coordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(4).padStart(8, "0")}${value >= 0 ? positive : negative}`;
}

async function configureSensor(location: ScheduleLocation): Promise<void> {
  const client = hueClient();
  if (!client || !state.sensorId) return;
  try {
    await client.v1("PUT", `/sensors/${state.sensorId}/config`, {
      lat: coordinate(location.lat, "N", "S"),
      long: coordinate(location.lon, "E", "W"),
      sunriseoffset: SENSOR_OFFSET,
      sunsetoffset: SENSOR_OFFSET,
    });
    // The newer API keeps its own copy (used by the Philips Hue app).
    const [geolocation] = await client.getAll("geolocation").catch(() => []);
    if (geolocation) {
      await client
        .update("geolocation", geolocation.id, { latitude: location.lat, longitude: location.lon })
        .catch((error) => log.warn("app", "schedule.geolocation_failed", String(error)));
    }
  } finally {
    await schedules.refresh();
  }
}

async function create(draft: AutomationDraft): Promise<void> {
  const client = hueClient();
  if (!client) throw new Error("No bridge connection");
  const rule = draft.trigger.kind === "sun";
  if (rule && !state.sensorId) throw new Error("The bridge has no daylight sensor");
  // First sun rule: the sensor needs the location and our early flip.
  if (rule && !state.sensorReady) await configureSensor(scheduleLocation());
  const body = rule ? buildRule(draft, state.sensorId!) : buildSchedule(draft, client.applicationKey);
  try {
    await client.v1("POST", rule ? "/rules" : "/schedules", body);
    log.info("app", "schedule.created", `Schedule “${draft.name}” created`, { trigger: draft.trigger, action: draft.action });
  } catch (error) {
    log.error("app", "schedule.create_failed", `Couldn't create a schedule: ${error}`, { body });
    throw error;
  } finally {
    await schedules.refresh();
  }
}

async function write(method: "PUT", existing: Automation, draft: AutomationDraft): Promise<void> {
  const client = hueClient();
  if (!client) throw new Error("No bridge connection");
  const body =
    existing.source === "rule" ? buildRule(draft, state.sensorId!) : buildSchedule(draft, client.applicationKey);
  // A schedule's autodelete can't be changed once created.
  delete body.autodelete;
  try {
    await client.v1(method, `/${path(existing)}/${existing.id}`, body);
  } finally {
    await schedules.refresh();
  }
}

async function remove(automation: Automation): Promise<void> {
  const client = hueClient();
  if (!client) return;
  patch({ automations: state.automations.filter((a) => a !== automation) });
  try {
    await client.v1("DELETE", `/${path(automation)}/${automation.id}`);
    log.info("app", "schedule.deleted", `Schedule “${automation.name}” deleted`);
  } finally {
    await schedules.refresh();
  }
}

async function replaceTimer(room: RoomView): Promise<void> {
  for (const timer of automationsOf(room).filter((a) => a.trigger.kind === "timer")) {
    await remove(timer);
  }
}

function path(automation: Automation): "schedules" | "rules" {
  return automation.source === "rule" ? "rules" : "schedules";
}

// --- Keeping up to date ----------------------------------------------------------

const POLL_MS = 60_000;
let wakeUp: ReturnType<typeof setTimeout> | null = null;

/** Re-read shortly after the next timer or schedule is due, so it drops off or moves on. */
function planWakeUps(): void {
  if (wakeUp) clearTimeout(wakeUp);
  const now = bridgeNow();
  const due = state.automations
    .map((a) => nextRunOf(a, now))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)[0];
  const delay = due ? Math.min(POLL_MS, due - now + 3_000) : POLL_MS;
  wakeUp = setTimeout(() => {
    // A hidden window's JS is suspended anyway; catch up when it's back.
    if (document.visibilityState === "visible") void schedules.refresh();
    else planWakeUps();
  }, Math.max(1_000, delay));
}

// Load once connected; reload after reconnecting (the bridge may have run some).
let wasReady = false;
subscribeApp(() => {
  const ready = getState().status === "ready";
  if (ready && !wasReady) void schedules.refresh();
  wasReady = ready;
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wasReady) void schedules.refresh();
});
