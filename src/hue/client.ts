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
// 2. The application key is created through the old v1 endpoint (POST /api) —
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

// --- Discovery ---------------------------------------------------------------

/**
 * mDNS via avahi-browse. The preferred method on Linux: it never leaves the
 * LAN. Needs a running avahi-daemon (present on virtually every desktop).
 */
async function discoverViaMdns(): Promise<BridgeCandidate[]> {
  try {
    const out = await invoke<string>("avahi_browse");

    const found = new Map<string, BridgeCandidate>();
    for (const line of out.split("\n")) {
      // Resolved records start with "=" and have ";"-separated fields
      if (!line.startsWith("=")) continue;
      const parts = line.split(";");
      const ip = parts[7];
      const txt = parts[9] ?? "";
      if (!ip) continue;
      const idMatch = txt.match(/bridgeid=([0-9a-fA-F]+)/);
      const id = (idMatch?.[1] ?? ip).toLowerCase();
      found.set(ip, { id, ip, source: "mdns" });
    }
    return [...found.values()];
  } catch {
    // No avahi-browse — not a problem, there is a fallback.
    return [];
  }
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
    return list
      .filter((b) => typeof b.internalipaddress === "string")
      .map((b) => ({
        id: (b.id ?? b.internalipaddress!).toLowerCase(),
        ip: b.internalipaddress!,
        source: "cloud",
      }));
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
    log.warn("bridge", "bridge.http_error", `${method} ${path} → HTTP ${res.status}`, {
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

export async function pairWithBridge(ip: string, appName = "hue-tray"): Promise<PairResult> {
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

// --- CLIP v2 resources -------------------------------------------------------

export type HueResource = {
  id: string;
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

/** Event stream messages — mirrors `StreamMessage` in hue.rs. */
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

  /** Fingerprint seen on the last connection — to be stored on first use. */
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
   * increasing backoff is done here — the bridge drops the connection on
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
            // Incomplete frame — skip it.
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
