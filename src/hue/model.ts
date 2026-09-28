// Assembling raw CLIP v2 resources into the model used by the UI and the tray.
//
// The mapping is not obvious: a light belongs to a device (light.owner.rid),
// and a room lists devices (room.children), not lights. Light reachability
// and product details also live separately, in zigbee_connectivity and device.

import { locale, t } from "../i18n";
import { averageColor, mirekToRgb, WARM_WHITE_MIREK, xyToRgb, type Rgb } from "../lib/color";
import type { BridgeInfo, LightCommand, LightView, ProductInfo, RoomView } from "../types";
import type { HueClient, HueResource } from "./client";

export type Snapshot = {
  lights: Map<string, HueResource>;
  rooms: Map<string, HueResource>;
  groupedLights: Map<string, HueResource>;
  devices: Map<string, HueResource>;
  bridge: HueResource | null;
  /** device rid -> whether zigbee reports a connection */
  connectivity: Map<string, boolean>;
};

export type HueView = { rooms: RoomView[]; lights: LightView[]; bridge: BridgeInfo };

export async function fetchSnapshot(client: HueClient): Promise<Snapshot> {
  const optional = (resource: string) => client.getAll(resource).catch(() => [] as HueResource[]);

  const [lights, rooms, groupedLights, zigbee, devices, bridges] = await Promise.all([
    client.getAll("light"),
    client.getAll("room"),
    client.getAll("grouped_light"),
    optional("zigbee_connectivity"),
    optional("device"),
    optional("bridge"),
  ]);

  const connectivity = new Map<string, boolean>();
  for (const z of zigbee) {
    if (z.owner?.rid) connectivity.set(z.owner.rid, z.status !== "disconnected");
  }

  return {
    lights: new Map(lights.map((l) => [l.id, l])),
    rooms: new Map(rooms.map((r) => [r.id, r])),
    groupedLights: new Map(groupedLights.map((g) => [g.id, g])),
    devices: new Map(devices.map((d) => [d.id, d])),
    bridge: bridges[0] ?? null,
    connectivity,
  };
}

/**
 * Applies an eventstream event to the snapshot. Events are partial — only
 * what changed is sent — and that holds inside nested objects too: a color
 * change arrives as `{color: {xy}}` without `gamut`, a temperature change as
 * `{color_temperature: {mirek}}` without `mirek_schema`. So nested objects
 * are merged one level deep instead of being replaced.
 */
export function applyEvent(snapshot: Snapshot, resource: HueResource): boolean {
  const bucket =
    resource.type === "light"
      ? snapshot.lights
      : resource.type === "grouped_light"
        ? snapshot.groupedLights
        : resource.type === "room"
          ? snapshot.rooms
          : resource.type === "device"
            ? snapshot.devices
            : null;

  if (bucket) {
    const current = bucket.get(resource.id);
    bucket.set(resource.id, current ? mergeResource(current, resource) : resource);
    return true;
  }

  if (resource.type === "zigbee_connectivity" && resource.owner?.rid) {
    snapshot.connectivity.set(resource.owner.rid, resource.status !== "disconnected");
    return true;
  }

  return false;
}

/**
 * A command as the partial resource the bridge would report once it is
 * applied — for optimistic updates. Fed through `applyEvent` like a real
 * event, so the snapshot is the single source of truth: a later event for one
 * light cannot roll back another light's pending change, and real events
 * still overwrite the prediction.
 */
export function commandToResource(
  type: "light" | "grouped_light",
  id: string,
  command: LightCommand,
): HueResource {
  const resource: HueResource = { id, type };
  if (command.on !== undefined) resource.on = { on: command.on };
  if (command.brightness !== undefined) resource.dimming = { brightness: command.brightness };
  if (command.xy) {
    resource.color = { xy: command.xy };
    // Color mode: the bridge drops the temperature.
    resource.color_temperature = { mirek: null, mirek_valid: false };
  } else if (command.mirek !== undefined) {
    resource.color_temperature = { mirek: command.mirek, mirek_valid: true };
  }
  return resource;
}

export function toHueView(
  snapshot: Snapshot,
  pairing: { ip: string; fingerprint: string | null },
): HueView {
  // device rid -> room id
  const deviceToRoom = new Map<string, string>();
  for (const room of snapshot.rooms.values()) {
    for (const child of room.children ?? []) {
      if (child.rtype === "device") deviceToRoom.set(child.rid, room.id);
    }
  }

  const lights: LightView[] = [...snapshot.lights.values()]
    .map((light) => {
      const deviceId = light.owner?.rid ?? null;
      const schema = light.color_temperature?.mirek_schema;
      return {
        id: light.id,
        name: light.metadata?.name ?? t("fallback.light"),
        roomId: deviceId ? (deviceToRoom.get(deviceId) ?? null) : null,
        on: light.on?.on ?? false,
        brightness: Math.round(light.dimming?.brightness ?? 0),
        capabilities: {
          dimming: Boolean(light.dimming),
          temperature: Boolean(light.color_temperature),
          color: Boolean(light.color),
        },
        mirek: light.color_temperature?.mirek ?? null,
        mirekRange: schema ? { min: schema.mirek_minimum, max: schema.mirek_maximum } : null,
        color: lightColor(light),
        xy: light.color?.xy ?? null,
        gamut: light.color?.gamut ?? null,
        reachable: deviceId ? (snapshot.connectivity.get(deviceId) ?? true) : true,
        product: deviceId ? productInfo(snapshot.devices.get(deviceId)) : null,
      } satisfies LightView;
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));

  const rooms: RoomView[] = [...snapshot.rooms.values()]
    .map((room) => {
      const groupedLightId = room.services?.find((s) => s.rtype === "grouped_light")?.rid ?? null;
      const grouped = groupedLightId ? snapshot.groupedLights.get(groupedLightId) : undefined;
      const roomLights = lights.filter((l) => l.roomId === room.id);

      return {
        id: room.id,
        name: room.metadata?.name ?? t("fallback.room"),
        groupedLightId,
        // grouped_light sometimes has no dimming, so average the lights that are on
        on: grouped?.on?.on ?? roomLights.some((l) => l.on),
        brightness: Math.round(grouped?.dimming?.brightness ?? averageBrightness(roomLights)),
        lightIds: roomLights.map((l) => l.id),
        color: roomColor(roomLights),
      } satisfies RoomView;
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));

  const bridgeDevice = snapshot.bridge?.owner?.rid
    ? snapshot.devices.get(snapshot.bridge.owner.rid)
    : undefined;
  const bridgeProduct = productInfo(bridgeDevice);

  return {
    rooms,
    lights,
    bridge: {
      name: bridgeDevice?.metadata?.name ?? null,
      bridgeId: snapshot.bridge?.bridge_id ?? null,
      ip: pairing.ip,
      modelId: bridgeProduct?.modelId ?? null,
      softwareVersion: bridgeProduct?.softwareVersion ?? null,
      timeZone: snapshot.bridge?.time_zone?.time_zone ?? null,
      fingerprint: pairing.fingerprint,
    },
  };
}

/**
 * The color a light is showing, at full brightness. A light is in one mode at
 * a time: temperature when `mirek_valid` (xy is then stale), else xy. Lights
 * that only dim count as warm white; plugs have no color at all.
 */
function lightColor(light: HueResource): Rgb | null {
  const temperature = light.color_temperature;
  if (temperature?.mirek != null && temperature.mirek_valid !== false) {
    return mirekToRgb(temperature.mirek);
  }
  if (light.color?.xy) return xyToRgb(light.color.xy, light.color.gamut);
  if (light.dimming || temperature) return mirekToRgb(WARM_WHITE_MIREK);
  return null;
}

/** Brightness-weighted average of the room's lights that are on and have a color. */
export function roomColor(lights: LightView[]): Rgb | null {
  const lit = lights.filter((l) => l.on && l.color);
  return averageColor(
    lit.map((l) => l.color!),
    lit.map((l) => (l.capabilities.dimming ? l.brightness : 100)),
  );
}

function mergeResource(current: HueResource, update: HueResource): HueResource {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(update)) {
    const previous = merged[key];
    merged[key] =
      isPlainObject(previous) && isPlainObject(value) ? { ...previous, ...value } : value;
  }
  return merged as HueResource;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function productInfo(device: HueResource | undefined): ProductInfo | null {
  const data = device?.product_data;
  if (!data) return null;
  return {
    name: data.product_name ?? null,
    modelId: data.model_id ?? null,
    softwareVersion: data.software_version ?? null,
  };
}

function averageBrightness(lights: LightView[]): number {
  const lit = lights.filter((l) => l.on);
  if (lit.length === 0) return 0;
  return lit.reduce((sum, l) => sum + l.brightness, 0) / lit.length;
}
