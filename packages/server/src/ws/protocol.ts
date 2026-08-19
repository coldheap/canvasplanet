import { SUB_ZOOM, type ClientMessage } from "@canvasplanet/shared";

const MAX_SUBSCRIPTIONS = 64;
const TILES_AT_SUB_ZOOM = 2 ** SUB_ZOOM;

/**
 * Parse the only two client-to-server WebSocket messages. JSON.parse plus a
 * TypeScript assertion is not validation: read-only sockets are public, so
 * every field is checked before it reaches the hub.
 */
export function parseClientMessage(text: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.t === "ping") return { t: "ping" };
  if (record.t !== "sub" || !Array.isArray(record.tiles) || record.tiles.length > MAX_SUBSCRIPTIONS) {
    return null;
  }

  const tiles: string[] = [];
  for (const value of record.tiles) {
    if (typeof value !== "string" || value.length > 32) return null;
    const parts = value.split("/");
    if (parts.length !== 3) return null;
    const z = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (
      !Number.isInteger(z) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      z !== SUB_ZOOM ||
      x < 0 ||
      y < 0 ||
      x >= TILES_AT_SUB_ZOOM ||
      y >= TILES_AT_SUB_ZOOM ||
      value !== `${z}/${x}/${y}`
    ) {
      return null;
    }
    tiles.push(value);
  }

  return { t: "sub", tiles };
}
