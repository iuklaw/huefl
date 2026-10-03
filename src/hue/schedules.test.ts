import { describe, expect, it } from "vitest";
import {
  actionBody,
  buildRule,
  buildSchedule,
  EVERY_DAY,
  localtime,
  nextRun,
  parseRules,
  parseSchedules,
  PREFIX,
  WEEKDAYS,
  type AutomationDraft,
} from "./schedules";

const KEY = "app-key";
const WEEKDAYS_MASK = WEEKDAYS.slice(0, 5).reduce((a, b) => a | b, 0); // Mon–Fri

/** Round trip through the bridge's representation. */
function viaSchedule(draft: AutomationDraft) {
  const [parsed] = parseSchedules({ "7": buildSchedule(draft, KEY) as never });
  return parsed;
}

function viaRule(draft: AutomationDraft) {
  const [parsed] = parseRules({ "3": buildRule(draft, "1") as never });
  return parsed;
}

describe("time schedules", () => {
  it("repeating on weekdays", () => {
    const draft: AutomationDraft = {
      groupId: "81",
      name: "Office",
      trigger: { kind: "time", hour: 7, minute: 30, days: WEEKDAYS_MASK },
      action: { on: true, brightness: 80, fadeMinutes: 10 },
    };
    const body = buildSchedule(draft, KEY);
    expect(body.localtime).toBe("W124/T07:30:00");
    expect(body).not.toHaveProperty("autodelete");
    expect(body.command).toEqual({
      address: "/api/app-key/groups/81/action",
      method: "PUT",
      body: { on: true, bri: 203, transitiontime: 6000 },
    });
    expect(viaSchedule(draft)).toMatchObject({ ...draft, id: "7", source: "schedule", enabled: true });
  });

  it("once, with a random start", () => {
    const draft: AutomationDraft = {
      groupId: "5",
      name: "Away",
      trigger: { kind: "time", hour: 19, minute: 5, days: 0, date: "2026-10-01", randomMinutes: 30 },
      action: { on: false },
    };
    const body = buildSchedule(draft, KEY);
    expect(body.localtime).toBe("2026-10-01T19:05:00A00:30:00");
    expect(body.autodelete).toBe(true);
    expect(viaSchedule(draft)?.trigger).toEqual(draft.trigger);
  });

  it("disabled stays disabled", () => {
    const draft: AutomationDraft = {
      groupId: "5",
      name: "x",
      enabled: false,
      trigger: { kind: "time", hour: 1, minute: 0, days: EVERY_DAY },
      action: { on: false },
    };
    expect(viaSchedule(draft)?.enabled).toBe(false);
  });
});

describe("timers", () => {
  it("counts down on the bridge and reads its start", () => {
    const body = buildSchedule(
      { groupId: "81", name: "Office", trigger: { kind: "timer", minutes: 15 }, action: { on: false } },
      KEY,
    );
    expect(body.localtime).toBe("PT00:15:00");
    expect(body.autodelete).toBe(true);

    const [parsed] = parseSchedules({ "9": { ...body, starttime: "2026-09-29T20:00:00" } as never });
    expect(parsed?.trigger).toEqual({ kind: "timer", minutes: 15, startedAt: Date.UTC(2026, 8, 29, 20, 0) });
  });

  it("long timers keep hours", () => {
    expect(localtime({ kind: "timer", minutes: 90 })).toBe("PT01:30:00");
  });
});

describe("sun rules", () => {
  it("sunset +30 min waits 150 min after the early flip", () => {
    const draft: AutomationDraft = {
      groupId: "81",
      name: "Living room",
      trigger: { kind: "sun", event: "sunset", offsetMinutes: 30, days: EVERY_DAY },
      action: { on: true },
    };
    const body = buildRule(draft, "1");
    expect(body.conditions).toEqual([
      { address: "/sensors/1/state/daylight", operator: "eq", value: "false" },
      { address: "/sensors/1/state/daylight", operator: "ddx", value: "PT02:30:00" },
    ]);
    expect(body.actions).toEqual([{ address: "/groups/81/action", method: "PUT", body: { on: true } }]);
    expect(viaRule(draft)).toMatchObject({ ...draft, id: "3", source: "rule" });
  });

  it("two hours before sunrise fires on the flip itself, only on chosen days", () => {
    const draft: AutomationDraft = {
      groupId: "2",
      name: "Bedroom",
      trigger: { kind: "sun", event: "sunrise", offsetMinutes: -120, days: WEEKDAYS_MASK },
      action: { on: true, brightness: 30 },
    };
    const body = buildRule(draft, "1");
    expect(body.conditions).toContainEqual({ address: "/sensors/1/state/daylight", operator: "dx" });
    expect(body.conditions).toContainEqual({ address: "/config/localtime", operator: "in", value: "W124/T00:00:00/T23:59:59" });
    expect(viaRule(draft)?.trigger).toEqual(draft.trigger);
  });
});

describe("parsing", () => {
  it("leaves other apps' entries alone", () => {
    expect(
      parseSchedules({
        "1": { name: "Wake up", command: { address: "/api/x/groups/1/action", body: { on: true } }, localtime: "W127/T07:00:00" },
      }),
    ).toEqual([]);
    expect(parseRules({ "1": { name: "Motion", conditions: [], actions: [] } })).toEqual([]);
  });

  it("still reads entries from before the rename (HT·)", () => {
    const [parsed] = parseSchedules({
      "4": { name: "HT·Office", command: { address: "/api/x/groups/81/action", body: { on: false } }, localtime: "PT00:10:00" },
    });
    expect(parsed).toMatchObject({ id: "4", name: "Office", groupId: "81" });
    // …and writes the new prefix.
    const body = buildSchedule({ groupId: "81", name: "Office", trigger: { kind: "timer", minutes: 10 }, action: { on: false } }, KEY);
    expect(body.name).toBe("HF·Office");
  });

  it("names are capped at the bridge's 32 characters", () => {
    const body = buildSchedule(
      { groupId: "1", name: "A very long room name that goes on", trigger: { kind: "timer", minutes: 1 }, action: { on: false } },
      KEY,
    );
    expect((body.name as string).length).toBe(32);
    expect((body.name as string).startsWith(PREFIX)).toBe(true);
  });

  it("brightness maps 1–100 % to 1–254", () => {
    expect(actionBody({ on: true, brightness: 100 }).bri).toBe(254);
    expect(actionBody({ on: true, brightness: 0 }).bri).toBe(1);
    expect(actionBody({ on: false, brightness: 50 })).toEqual({ on: false });
  });
});

describe("nextRun", () => {
  const utc = () => 0; // zone offset: UTC
  const warsawSummer = () => 120;

  it("skips to the next chosen weekday", () => {
    // Tue 2026-09-29 12:00 UTC; Mon–Fri 07:30 -> Wed 07:30.
    const now = Date.UTC(2026, 8, 29, 12, 0);
    expect(nextRun({ kind: "time", hour: 7, minute: 30, days: WEEKDAYS_MASK }, now, utc)).toBe(Date.UTC(2026, 8, 30, 7, 30));
    // Sunday only -> Sun 2026-10-04.
    expect(nextRun({ kind: "time", hour: 7, minute: 30, days: 1 }, now, utc)).toBe(Date.UTC(2026, 9, 4, 7, 30));
  });

  it("uses the bridge's time zone", () => {
    const now = Date.UTC(2026, 8, 29, 12, 0); // 14:00 in Warsaw
    // 15:00 Warsaw = 13:00 UTC, still today.
    expect(nextRun({ kind: "time", hour: 15, minute: 0, days: EVERY_DAY }, now, warsawSummer)).toBe(Date.UTC(2026, 8, 29, 13, 0));
  });

  it("once in the past never runs; timers end after their minutes", () => {
    const now = Date.UTC(2026, 8, 29, 12, 0);
    expect(nextRun({ kind: "time", hour: 7, minute: 0, days: 0, date: "2026-09-29" }, now, utc)).toBeNull();
    expect(nextRun({ kind: "timer", minutes: 15, startedAt: now }, now, utc)).toBe(now + 15 * 60_000);
  });
});
