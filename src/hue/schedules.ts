// Light schedules that run on the bridge itself, so they fire with the
// computer off or the app closed. Pure: builds bridge (API v1) bodies from our
// model and parses them back — the bridge is the single source of truth.
//
//   fixed time, repeating   schedule  localtime "W124/T07:30:00"
//   fixed time, once        schedule  localtime "2026-09-30T07:30:00", autodelete
//   countdown               schedule  localtime "PT00:15:00", autodelete
//   sunrise / sunset        rule on the Daylight sensor (see SUN_LEAD)
//
// Ours are recognised by the name prefix (HF·, or HT· from before the
// rename); other apps' entries are left alone.

/** Name prefix of everything HueFL creates on the bridge (names: max 32 chars). */
export const PREFIX = "HF·";
/** From before the rename (Hue Tray): still ours, rewritten as HF· when edited. */
const LEGACY_PREFIXES = ["HT·"];

/** The name without our prefix, or null if the entry isn't ours. */
function ownName(name: string | undefined): string | null {
  const prefix = [PREFIX, ...LEGACY_PREFIXES].find((p) => name?.startsWith(p));
  return prefix ? name!.slice(prefix.length) : null;
}
const NAME_MAX = 32;

/**
 * The Daylight sensor has one global offset, but each sun rule wants its own.
 * So the sensor is set to flip SUN_LEAD minutes early, and every rule waits
 * `offset + SUN_LEAD` after the flip: per-rule offsets of −SUN_LEAD…+SUN_LEAD.
 */
export const SUN_LEAD = 120;

/** Weekday bits as the bridge counts them: Monday 64 … Sunday 1. */
export const WEEKDAYS = [64, 32, 16, 8, 4, 2, 1] as const;
export const EVERY_DAY = 127;

export type ScheduleAction = {
  on: boolean;
  /** 1–100 %; only with `on`. Unset = the lights' last brightness. */
  brightness?: number;
  /** Fade over this many minutes instead of switching at once. */
  fadeMinutes?: number;
};

export type Trigger =
  | {
      kind: "time";
      hour: number;
      minute: number;
      /** Weekday mask (WEEKDAYS); 0 = once, on `date`. */
      days: number;
      /** YYYY-MM-DD, for `days: 0`. */
      date?: string;
      /** Start at a random moment within this many minutes ("away" mode). */
      randomMinutes?: number;
    }
  | {
      kind: "timer";
      minutes: number;
      /** When the bridge started counting (ms since epoch, bridge clock). */
      startedAt?: number;
    }
  | {
      kind: "sun";
      event: "sunrise" | "sunset";
      /** Minutes after (+) or before (−) the event, within ±SUN_LEAD. */
      offsetMinutes: number;
      days: number;
    };

export type Automation = {
  /** Bridge id, unique per `source`. */
  id: string;
  source: "schedule" | "rule";
  /** The room's v1 group id ("81" for /groups/81). */
  groupId: string;
  trigger: Trigger;
  action: ScheduleAction;
  enabled: boolean;
  name: string;
};

export type AutomationDraft = Omit<Automation, "id" | "source" | "enabled"> & { enabled?: boolean };

// --- Building ------------------------------------------------------------------

export function automationName(label: string): string {
  return (PREFIX + label).slice(0, NAME_MAX);
}

/** The group command, as the v1 API takes it. */
export function actionBody(action: ScheduleAction): Record<string, unknown> {
  const body: Record<string, unknown> = { on: action.on };
  if (action.on && action.brightness !== undefined) {
    body.bri = clamp(Math.round(action.brightness * 2.54), 1, 254);
  }
  if (action.fadeMinutes) {
    // Deciseconds, at most 65535 (~109 min).
    body.transitiontime = Math.min(65535, Math.round(action.fadeMinutes * 600));
  }
  return body;
}

export function localtime(trigger: Exclude<Trigger, { kind: "sun" }>): string {
  if (trigger.kind === "timer") return `PT${hms(trigger.minutes * 60)}`;
  const time = `T${pad(trigger.hour)}:${pad(trigger.minute)}:00`;
  const random = trigger.randomMinutes ? `A${hms(trigger.randomMinutes * 60)}` : "";
  return trigger.days === 0 ? `${trigger.date}${time}${random}` : `W${trigger.days}/${time}${random}`;
}

/** Body for POST/PUT /schedules. `key` is the application key (v1 addresses include it). */
export function buildSchedule(draft: AutomationDraft, key: string): Record<string, unknown> {
  if (draft.trigger.kind === "sun") throw new Error("sun triggers are rules");
  const once = draft.trigger.kind === "timer" || draft.trigger.days === 0;
  return {
    name: automationName(draft.name),
    description: "HueFL",
    command: {
      address: `/api/${key}/groups/${draft.groupId}/action`,
      method: "PUT",
      body: actionBody(draft.action),
    },
    localtime: localtime(draft.trigger),
    status: draft.enabled === false ? "disabled" : "enabled",
    ...(once ? { autodelete: true } : {}),
  };
}

/** Body for POST/PUT /rules. `sensorId`: the Daylight sensor. */
export function buildRule(draft: AutomationDraft, sensorId: string): Record<string, unknown> {
  const trigger = draft.trigger;
  if (trigger.kind !== "sun") throw new Error("only sun triggers are rules");
  const daylight = `/sensors/${sensorId}/state/daylight`;
  const wait = clamp(trigger.offsetMinutes, -SUN_LEAD, SUN_LEAD) + SUN_LEAD;
  const conditions: Record<string, string>[] = [
    // Sunrise: daylight turns true; sunset: false.
    { address: daylight, operator: "eq", value: String(trigger.event === "sunrise") },
    wait === 0
      ? { address: daylight, operator: "dx" }
      : { address: daylight, operator: "ddx", value: `PT${hms(wait * 60)}` },
  ];
  if (trigger.days !== EVERY_DAY && trigger.days !== 0) {
    conditions.push({ address: "/config/localtime", operator: "in", value: `W${trigger.days}/T00:00:00/T23:59:59` });
  }
  return {
    name: automationName(draft.name),
    conditions,
    actions: [{ address: `/groups/${draft.groupId}/action`, method: "PUT", body: actionBody(draft.action) }],
    status: draft.enabled === false ? "disabled" : "enabled",
  };
}

// --- Parsing -------------------------------------------------------------------

type V1Schedule = {
  name?: string;
  command?: { address?: string; body?: Record<string, unknown> };
  localtime?: string;
  starttime?: string;
  status?: string;
};

type V1Rule = {
  name?: string;
  conditions?: { address?: string; operator?: string; value?: string }[];
  actions?: { address?: string; body?: Record<string, unknown> }[];
  status?: string;
};

/** Ours from GET /schedules (id → schedule); anything unreadable is skipped. */
export function parseSchedules(all: Record<string, V1Schedule>): Automation[] {
  return Object.entries(all).flatMap(([id, s]) => {
    const name = ownName(s.name);
    if (name === null) return [];
    const groupId = s.command?.address?.match(/\/groups\/(\d+)\/action$/)?.[1];
    const trigger = parseLocaltime(s.localtime ?? "", s.starttime);
    if (!groupId || !trigger) return [];
    return [
      {
        id,
        source: "schedule" as const,
        groupId,
        trigger,
        action: parseAction(s.command?.body ?? {}),
        enabled: s.status !== "disabled",
        name,
      },
    ];
  });
}

/** Ours from GET /rules. */
export function parseRules(all: Record<string, V1Rule>): Automation[] {
  return Object.entries(all).flatMap(([id, r]) => {
    const name = ownName(r.name);
    if (name === null) return [];
    const conditions = r.conditions ?? [];
    const daylight = conditions.find((c) => c.address?.endsWith("/state/daylight") && c.operator === "eq");
    const change = conditions.find((c) => c.address?.endsWith("/state/daylight") && (c.operator === "dx" || c.operator === "ddx"));
    const groupId = r.actions?.[0]?.address?.match(/^\/groups\/(\d+)\/action$/)?.[1];
    if (!daylight || !change || !groupId) return [];
    const wait = change.operator === "dx" ? 0 : Math.round(ptSeconds(change.value ?? "") / 60);
    const days = conditions.find((c) => c.address === "/config/localtime")?.value?.match(/^W(\d+)\//)?.[1];
    return [
      {
        id,
        source: "rule" as const,
        groupId,
        trigger: {
          kind: "sun" as const,
          event: daylight.value === "true" ? ("sunrise" as const) : ("sunset" as const),
          offsetMinutes: wait - SUN_LEAD,
          days: days ? Number(days) : EVERY_DAY,
        },
        action: parseAction(r.actions?.[0]?.body ?? {}),
        enabled: r.status !== "disabled",
        name,
      },
    ];
  });
}

function parseLocaltime(value: string, starttime?: string): Exclude<Trigger, { kind: "sun" }> | null {
  const random = (a?: string, b?: string, c?: string) =>
    a ? Math.round((Number(a) * 3600 + Number(b) * 60 + Number(c)) / 60) || undefined : undefined;

  let m = value.match(/^W(\d+)\/T(\d\d):(\d\d):\d\d(?:A(\d\d):(\d\d):(\d\d))?$/);
  if (m) {
    return { kind: "time", days: Number(m[1]), hour: Number(m[2]), minute: Number(m[3]), randomMinutes: random(m[4], m[5], m[6]) };
  }
  m = value.match(/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):\d\d(?:A(\d\d):(\d\d):(\d\d))?$/);
  if (m) {
    return { kind: "time", days: 0, date: m[1], hour: Number(m[2]), minute: Number(m[3]), randomMinutes: random(m[4], m[5], m[6]) };
  }
  if (/^PT\d\d:\d\d:\d\d$/.test(value)) {
    const startedAt = starttime ? Date.parse(`${starttime}Z`) : NaN;
    return {
      kind: "timer",
      minutes: Math.round(ptSeconds(value) / 60),
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    };
  }
  return null;
}

function parseAction(body: Record<string, unknown>): ScheduleAction {
  const action: ScheduleAction = { on: body.on === true };
  if (action.on && typeof body.bri === "number") action.brightness = Math.max(1, Math.round(body.bri / 2.54));
  if (typeof body.transitiontime === "number" && body.transitiontime > 0) {
    action.fadeMinutes = Math.round(body.transitiontime / 60) / 10;
  }
  return action;
}

// --- When ----------------------------------------------------------------------

/**
 * Next run of a time or timer trigger, in ms since epoch. `now` and the
 * result are wall-clock ms in the bridge's reckoning; `zoneOffset(ms)` gives
 * the bridge time zone's UTC offset in minutes at that moment (DST aware).
 * Null when it won't run again.
 */
export function nextRun(
  trigger: Exclude<Trigger, { kind: "sun" }>,
  now: number,
  zoneOffset: (ms: number) => number,
): number | null {
  if (trigger.kind === "timer") {
    return trigger.startedAt !== undefined ? trigger.startedAt + trigger.minutes * 60_000 : null;
  }
  // Work in "local" ms (UTC shifted by the zone offset), then shift back.
  const toLocal = (ms: number) => ms + zoneOffset(ms) * 60_000;
  const fromLocal = (local: number) => local - zoneOffset(local) * 60_000;
  const minuteOfDay = trigger.hour * 60 + trigger.minute;

  if (trigger.days === 0) {
    if (!trigger.date) return null;
    const at = fromLocal(Date.parse(`${trigger.date}T00:00:00Z`) + minuteOfDay * 60_000);
    return at > now ? at : null;
  }
  const local = toLocal(now);
  const today = Math.floor(local / 86_400_000) * 86_400_000;
  for (let day = 0; day <= 7; day++) {
    const start = today + day * 86_400_000;
    const weekday = (new Date(start).getUTCDay() + 6) % 7; // Monday = 0
    if (!(trigger.days & WEEKDAYS[weekday]!)) continue;
    const at = fromLocal(start + minuteOfDay * 60_000);
    if (at > now) return at;
  }
  return null;
}

// --- Helpers -------------------------------------------------------------------

function pad(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}

function hms(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}

function ptSeconds(value: string): number {
  const m = value.match(/^PT(\d\d):(\d\d):(\d\d)$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
