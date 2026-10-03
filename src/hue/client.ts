// Client for the local Philips Hue CLIP v2 API.
//
// Two things worth knowing about the bridge:
//
// 1. It speaks HTTPS only, and its certificate carries the bridge ID in the CN
//    (not a hostname), has no SAN and is signed by a Signify root that is not
//    in any system trust store. Regular TLS verification cannot succeed.
//    The fix is pinning the fingerprint on first connection (the SSH model).
//    Do the first pairing on a network you trust.
//
//    The webview does not allow custom TLS verification, so the transport
//    itself lives in Rust (src-tauri/src/hue.rs). Everything else is here.
//
// 2. The application key is created through the old v1 endpoint (POST /api) -
//    still the only way, v2 included.

import { Channel, invoke } from "@tauri-apps/api/core";
import { log } from "../core/log";
import { t } from "../i18n";
import type { BridgeCandidate } from "../types";
import type { Settings } from "../store";

export class LinkButtonNotPressed extends Error {
  constructor() {
    super(t("error.link_button"));
    this.name = "LinkButtonNotPressed";
  }
}

export class PairTimedOut extends Error {
  constructor() {
    super(t("error.link_timeout"));
    this.name = "PairTimedOut";
  }
}

// --- Discovery ---------------------------------------------------------------

/**
 * mDNS via avahi-browse. The preferred method on Linux: it never leaves the
 * LAN. Needs a running avahi-daemon (present on virtually every desktop).
 */
async function discoverViaMdns(): Promise<BridgeCandidate[]> {
  try {
    return parseAvahi(await invoke<string>("avahi_browse"));
  } catch {
    // No avahi-browse - not a problem, there is a fallback.
    return [];
  }
}

/**
 * `avahi-browse -rpt` output -> one candidate per bridge. A bridge is listed
 * once per interface and mDNS transport; only IPv4 addresses are kept (the
 * sync stream is IPv4-only, and a link-local IPv6 address comes without its
 * interface).
 */
export function parseAvahi(out: string): BridgeCandidate[] {
  const found = new Map<string, BridgeCandidate>();
  for (const line of out.split("\n")) {
    // Resolved records start with "=" and have ";"-separated fields:
    // =;iface;transport;name;type;domain;host;address;port;txt
    // (the transport says how the record came, not the address's family)
    if (!line.startsWith("=")) continue;
    const parts = line.split(";");
    const ip = parts[7];
    if (!ip || ip.includes(":")) continue;
    const idMatch = (parts[9] ?? "").match(/bridgeid=([0-9a-fA-F]+)/);
    const id = (idMatch?.[1] ?? ip).toLowerCase();
    if (!found.has(id)) found.set(id, { id, ip, source: "mdns" });
  }
  return [...found.values()];
}

/**
 * Signify's cloud endpoint. It sends no bridge data or keys, but Signify
 * learns your public IP address. Used only as a fallback. Goes through Rust
 * because CORS would block it from the webview.
 */
async function discoverViaCloud(): Promise<BridgeCandidate[]> {
  try {
    const list = JSON.parse(await invoke<string>("discover_cloud")) as Array<{
      id?: string;
      internalipaddress?: string;
    }>;
    const found = new Map<string, BridgeCandidate>();
    for (const b of list) {
      if (typeof b.internalipaddress !== "string") continue;
      const id = (b.id ?? b.internalipaddress).toLowerCase();
      if (!found.has(id)) found.set(id, { id, ip: b.internalipaddress, source: "cloud" });
    }
    return [...found.values()];
  } catch {
    return [];
  }
}

export async function discoverBridges(): Promise<BridgeCandidate[]> {
  const mdns = await discoverViaMdns();
  if (mdns.length > 0) {
    log.info("pairing", "discover.result", `Found ${mdns.length} bridge(s) via mDNS`, { ips: mdns.map((b) => b.ip) });
    return mdns;
  }
  const cloud = await discoverViaCloud();
  log.info("pairing", "discover.result", `mDNS found nothing; cloud discovery found ${cloud.length}`, {
    ips: cloud.map((b) => b.ip),
  });
  return cloud;
}

// --- Transport ---------------------------------------------------------------

type TlsPin = {
  /** The stored fingerprint, or null on first contact. */
  expected: string | null;
  /** The fingerprint actually seen by the Rust side. */
  seen: string | null;
};

type HueResponse = { status: number; body: string; fingerprint: string | null };

/**
 * Parses a bridge response. On errors (unknown path, overload, missing key)
 * the bridge serves an HTML page instead of JSON, so a parse failure is
 * reported with the HTTP status rather than a cryptic JSON error.
 */
function parseBody<T>(res: HueResponse): T {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(t("error.http_status", { status: res.status }));
  }
}

/**
 * The only place in TS that talks to the bridge. Certificate verification
 * (and the error on a fingerprint mismatch) happens in Rust.
 */
async function hueFetch(
  ip: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | null,
  pin: TlsPin,
): Promise<HueResponse> {
  const res = await invoke<HueResponse>("hue_request", {
    ip,
    method,
    path,
    headers,
    body,
    pin: pin.expected,
  });
  if (res.fingerprint) pin.seen = res.fingerprint;
  if (res.status >= 400) {
    // The body is what explains the failure (often an HTML error page).
    log.warn("bridge", "bridge.http_error", `${method} ${path} -> HTTP ${res.status}`, {
      status: res.status,
      body: res.body.slice(0, 500),
    });
  }
  return res;
}

// --- Pairing -----------------------------------------------------------------

export type PairResult = {
  applicationKey: string;
  clientKey: string | null;
  certFingerprint: string | null;
};

export async function pairWithBridge(ip: string, appName = "huefl"): Promise<PairResult> {
  const pin: TlsPin = { expected: null, seen: null };
  const device = await invoke<string>("device_name").catch(() => "linux");
  const res = await hueFetch(
    ip,
    "POST",
    "/api",
    { "content-type": "application/json" },
    JSON.stringify({ devicetype: `${appName}#${device}`, generateclientkey: true }),
    pin,
  );

  const payload = parseBody<
    Array<{
      success?: { username: string; clientkey?: string };
      error?: { type: number; description: string };
    }>
  >(res);

  const entry = payload[0];
  if (entry?.error) {
    // 101 = "link button not pressed"
    if (entry.error.type === 101) throw new LinkButtonNotPressed();
    throw new Error(entry.error.description);
  }
  if (!entry?.success?.username) {
    throw new Error(t("error.unexpected_response"));
  }

  return {
    applicationKey: entry.success.username,
    clientKey: entry.success.clientkey ?? null,
    certFingerprint: pin.seen,
  };
}

/** How long pairing waits for the link button - the bridge may be out of reach. */
export const LINK_WAIT_MS = 90_000;
const LINK_POLL_MS = 2_000;

/**
 * Pairs as soon as the link button is pressed: retries while the bridge
 * answers "link button not pressed", for up to LINK_WAIT_MS. The first try
 * goes out at once, so pressing the button before clicking Pair still works.
 * Any other error (wrong IP, TLS, timeout) ends it right away. Returns null
 * when `signal` aborts - also if a key arrives after that: the user has
 * moved on, and an unused key on the bridge is harmless.
 */
export async function pairWhenPressed(ip: string, signal: AbortSignal): Promise<PairResult | null> {
  const deadline = Date.now() + LINK_WAIT_MS;
  while (!signal.aborted) {
    try {
      const result = await pairWithBridge(ip);
      return signal.aborted ? null : result;
    } catch (error) {
      if (signal.aborted) return null;
      if (!(error instanceof LinkButtonNotPressed)) throw error;
    }
    if (Date.now() + LINK_POLL_MS > deadline) throw new PairTimedOut();
    await sleep(LINK_POLL_MS, signal);
  }
  return null;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

// --- CLIP v2 resources -------------------------------------------------------

export type HueResource = {
  id: string;
  /** The same resource in API v1, e.g. "/groups/81" (schedules use v1). */
  id_v1?: string;
  type: string;
  metadata?: { name?: string; archetype?: string };
  owner?: { rid: string; rtype: string };
  children?: Array<{ rid: string; rtype: string }>;
  services?: Array<{ rid: string; rtype: string }>;
  on?: { on: boolean };
  dimming?: { brightness: number; min_dim_level?: number };
  color?: {
    xy?: { x: number; y: number };
    gamut?: { red: { x: number; y: number }; green: { x: number; y: number }; blue: { x: number; y: number } };
    gamut_type?: string;
  };
  color_temperature?: {
    mirek: number | null;
    mirek_valid?: boolean;
    mirek_schema?: { mirek_minimum: number; mirek_maximum: number };
  };
  /** zigbee_connectivity: "connected" | "disconnected" | "connectivity_issue" | ... */
  status?: string;
  /** device */
  product_data?: {
    model_id?: string;
    product_name?: string;
    software_version?: string;
    manufacturer_name?: string;
  };
  /** bridge */
  bridge_id?: string;
  time_zone?: { time_zone?: string };
};

export type HueEvent = {
  type: string;
  data: HueResource[];
};

/** Event stream messages - mirrors `StreamMessage` in hue.rs. */
type StreamMessage = { kind: "open" } | { kind: "data"; payload: string };

let nextStreamId = 1;

export class HueClient {
  readonly ip: string;
  private readonly key: string;
  private readonly pin: TlsPin;

  constructor(settings: Pick<Settings, "bridgeIp" | "applicationKey" | "certFingerprint">) {
    if (!settings.bridgeIp || !settings.applicationKey) {
      throw new Error(t("error.not_configured"));
    }
    this.ip = settings.bridgeIp;
    this.key = settings.applicationKey;
    this.pin = { expected: settings.certFingerprint, seen: null };
  }

  /** Fingerprint seen on the last connection - to be stored on first use. */
  get seenFingerprint(): string | null {
    return this.pin.seen;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await hueFetch(
      this.ip,
      method,
      path,
      {
        "hue-application-key": this.key,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body ? JSON.stringify(body) : null,
      this.pin,
    );

    if (res.status === 401 || res.status === 403) {
      throw new Error(t("error.key_rejected"));
    }

    const json = parseBody<{ data?: T; errors?: Array<{ description: string }> }>(res);
    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors.map((e) => e.description).join("; "));
    }
    return (json.data ?? ([] as unknown)) as T;
  }

  /**
   * API v1 (/api/<key>/…) - still the only way to create schedules and rules
   * that run on the bridge. Writes answer with a list of `success` / `error`
   * entries; an error entry throws.
   */
  async v1<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await hueFetch(
      this.ip,
      method,
      `/api/${this.key}${path}`,
      body ? { "content-type": "application/json" } : {},
      body ? JSON.stringify(body) : null,
      this.pin,
    );
    const json = parseBody<unknown>(res);
    if (Array.isArray(json)) {
      const errors = json.flatMap((entry) =>
        entry && typeof entry === "object" && "error" in entry
          ? [(entry as { error: { description?: string } }).error.description ?? "bridge error"]
          : [],
      );
      if (errors.length > 0) throw new Error(errors.join("; "));
    }
    return json as T;
  }

  /** The application key, for v1 addresses inside schedule commands. */
  get applicationKey(): string {
    return this.key;
  }

  getAll(resource: string): Promise<HueResource[]> {
    return this.request<HueResource[]>("GET", `/clip/v2/resource/${resource}`);
  }

  update(resource: string, id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/clip/v2/resource/${resource}/${id}`, body);
  }

  /**
   * Event stream (SSE). The bridge pushes every state change, so there is no
   * need to poll. Returns a stop function.
   *
   * Rust handles the connection and frame splitting; reconnecting with an
   * increasing backoff is done here - the bridge drops the connection on
   * firmware restarts or IP changes.
   */
  subscribe(onEvent: (events: HueEvent[]) => void, onStatus?: (ok: boolean) => void): () => void {
    let stopped = false;
    let currentId: number | null = null;
    let backoff = 1000;

    const loop = async () => {
      while (!stopped) {
        const id = nextStreamId++;
        currentId = id;

        const channel = new Channel<StreamMessage>();
        channel.onmessage = (message) => {
          if (stopped) return;
          if (message.kind === "open") {
            log.info("bridge", "stream.open", "Event stream connected");
            onStatus?.(true);
            backoff = 1000;
            return;
          }
          try {
            onEvent(JSON.parse(message.payload) as HueEvent[]);
          } catch {
            // Incomplete frame - skip it.
          }
        };

        try {
          // Resolves when the bridge closes the stream or we call stop.
          await invoke("hue_stream", {
            id,
            ip: this.ip,
            key: this.key,
            pin: this.pin.expected,
            onMessage: channel,
          });
          if (!stopped) {
            log.warn("bridge", "stream.closed", `Event stream closed by the bridge; reconnecting in ${backoff / 1000} s`);
          }
        } catch (error) {
          log.warn("bridge", "stream.error", `Event stream failed; reconnecting in ${backoff / 1000} s`, {
            error: String(error),
          });
          onStatus?.(false);
        }

        if (stopped) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    };

    void loop();

    return () => {
      stopped = true;
      if (currentId !== null) void invoke("hue_stream_close", { id: currentId });
    };
  }
}
