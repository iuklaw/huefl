import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("../core/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { LINK_WAIT_MS, PairTimedOut, pairWhenPressed, parseAvahi } from "./client";

describe("parseAvahi", () => {
  it("lists a bridge once, by its IPv4 address", () => {
    const out = [
      "+;eno1;IPv4;Hue\\032Bridge\\032-\\032BE035E;_hue._tcp;local",
      // Found over both transports - the IPv6 one may still carry the IPv4 address.
      '=;eno1;IPv4;Hue\\032Bridge\\032-\\032BE035E;_hue._tcp;local;ecb5fabe035e.local;192.168.10.233;443;"modelid=BSB002" "bridgeid=ecb5fafffebe035e"',
      '=;eno1;IPv6;Hue\\032Bridge\\032-\\032BE035E;_hue._tcp;local;ecb5fabe035e.local;192.168.10.233;443;"modelid=BSB002" "bridgeid=ecb5fafffebe035e"',
      '=;eno1;IPv6;Hue\\032Bridge\\032-\\032BE035E;_hue._tcp;local;ecb5fabe035e.local;fe80::217:88ff:febe:35e;443;"modelid=BSB002" "bridgeid=ecb5fafffebe035e"',
      '=;wlan0;IPv4;Hue\\032Bridge\\032-\\032BE035E;_hue._tcp;local;ecb5fabe035e.local;192.168.20.5;443;"modelid=BSB002" "bridgeid=ecb5fafffebe035e"',
    ].join("\n");
    expect(parseAvahi(out)).toEqual([{ id: "ecb5fafffebe035e", ip: "192.168.10.233", source: "mdns" }]);
  });

  it("keeps different bridges apart", () => {
    const out = [
      '=;eno1;IPv4;A;_hue._tcp;local;a.local;192.168.1.2;443;"bridgeid=AAAA"',
      '=;eno1;IPv4;B;_hue._tcp;local;b.local;192.168.1.3;443;"bridgeid=BBBB"',
    ].join("\n");
    expect(parseAvahi(out).map((b) => b.id)).toEqual(["aaaa", "bbbb"]);
  });
});

const LINK_NOT_PRESSED = JSON.stringify([{ error: { type: 101, description: "link button not pressed" } }]);
const PAIRED = JSON.stringify([{ success: { username: "app-key", clientkey: "client-key" } }]);

/** Answers each POST /api with the next body; device_name gets "tester". */
function bridgeAnswers(...bodies: string[]) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "device_name") return "tester";
    const body = bodies.length > 1 ? bodies.shift()! : bodies[0];
    return { status: 200, body, fingerprint: "ab:cd" };
  });
}

const posts = () => invoke.mock.calls.filter(([command]) => command === "hue_request").length;

describe("pairWhenPressed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("pairs once the button is pressed", async () => {
    bridgeAnswers(LINK_NOT_PRESSED, LINK_NOT_PRESSED, PAIRED);
    const pairing = pairWhenPressed("192.168.1.2", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pairing).resolves.toEqual({
      applicationKey: "app-key",
      clientKey: "client-key",
      certFingerprint: "ab:cd",
    });
    expect(posts()).toBe(3);
  });

  it("pairs at once when the button was pressed first", async () => {
    bridgeAnswers(PAIRED);
    await expect(pairWhenPressed("192.168.1.2", new AbortController().signal)).resolves.not.toBeNull();
    expect(posts()).toBe(1);
  });

  it("gives up after the wait window", async () => {
    bridgeAnswers(LINK_NOT_PRESSED);
    const pairing = pairWhenPressed("192.168.1.2", new AbortController().signal);
    const failed = expect(pairing).rejects.toBeInstanceOf(PairTimedOut);
    await vi.advanceTimersByTimeAsync(LINK_WAIT_MS + 1_000);
    await failed;
    expect(posts()).toBeLessThanOrEqual(LINK_WAIT_MS / 2_000 + 1);
  });

  it("stops at once on other errors", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "device_name") return "tester";
      throw "Bridge unreachable";
    });
    await expect(pairWhenPressed("192.168.1.2", new AbortController().signal)).rejects.toBe("Bridge unreachable");
    expect(posts()).toBe(1);
  });

  it("returns null and stops asking when cancelled", async () => {
    bridgeAnswers(LINK_NOT_PRESSED);
    const controller = new AbortController();
    const pairing = pairWhenPressed("192.168.1.2", controller.signal);
    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    await expect(pairing).resolves.toBeNull();
    const asked = posts();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(posts()).toBe(asked);
  });
});
