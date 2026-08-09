import {
  HISTORY_BUCKET_MS,
  HISTORY_MAX_AGE_MS,
  TILES_PER_AXIS,
  Z_PIXEL,
} from "@worldcanvas/shared";
import type { FastifyInstance } from "fastify";
import { readTile } from "../tiles/cache.js";
import { renderHistoryTile } from "../tiles/renderer.js";

const HISTORY_LRU_MAX = 200;
const historyLru = new Map<string, Buffer>();

function cachedHistoryTile(key: string): Buffer | undefined {
  const tile = historyLru.get(key);
  if (!tile) return undefined;
  historyLru.delete(key);
  historyLru.set(key, tile);
  return tile;
}

function rememberHistoryTile(key: string, tile: Buffer): Buffer {
  historyLru.set(key, tile);
  if (historyLru.size > HISTORY_LRU_MAX) {
    const oldest = historyLru.keys().next().value;
    if (oldest !== undefined) historyLru.delete(oldest);
  }
  return tile;
}

/**
 * The canvas itself. By far the heaviest route, and the one Cloudflare's edge
 * absorbs — `s-maxage` lets CF hold a tile for a day while `max-age=0` keeps
 * browsers revalidating, so an explicit purge from the tile worker is picked
 * up immediately.
 */
function validParams(z: number, x: number, y: number): boolean {
  const max = 2 ** z;
  return (
    Number.isInteger(z) &&
    z >= 0 &&
    z <= Z_PIXEL &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < max &&
    y < max &&
    (z !== Z_PIXEL || (x < TILES_PER_AXIS && y < TILES_PER_AXIS))
  );
}

export function registerTileRoutes(app: FastifyInstance): void {
  // Read-only past canvas. The API namespace intentionally bypasses the
  // live tile route's day-long edge caching; arbitrary history selections
  // are instead bounded and held in a small process-local LRU.
  app.get<{ Params: { at: string; z: string; x: string; y: string } }>(
    "/api/history/tiles/:at/:z/:x/:y.png",
    async (req, reply) => {
      const at = Number(req.params.at);
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      const now = Date.now();
      if (
        !validParams(z, x, y) ||
        z !== Z_PIXEL ||
        !Number.isSafeInteger(at) ||
        at % HISTORY_BUCKET_MS !== 0 ||
        at < now - HISTORY_MAX_AGE_MS - HISTORY_BUCKET_MS ||
        at > now
      ) {
        return reply.code(404).send();
      }

      const key = `${at}/${x}/${y}`;
      const buf = cachedHistoryTile(key) ?? rememberHistoryTile(key, await renderHistoryTile(x, y, at));
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "private, max-age=300")
        .header("ETag", `"history-${key}-${buf.length}"`)
        .send(buf);
    },
  );

  app.get<{ Params: { z: string; x: string; y: string } }>(
    `/tiles/z${Z_PIXEL}/:z/:x/:y.png`,
    async (req, reply) => {
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      if (!validParams(z, x, y)) return reply.code(404).send();

      const buf = await readTile(z, x, y, "color");
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=0, s-maxage=86400")
        .header("ETag", `"${z}-${x}-${y}-${buf.length}"`)
        .send(buf);
    },
  );

  // The density overlay — same grid, same cache shape, a different render
  // mode. A separate path rather than a query param keeps it cacheable by
  // Cloudflare and any browser cache on its own URL.
  app.get<{ Params: { z: string; x: string; y: string } }>(
    `/tiles/z${Z_PIXEL}/heat/:z/:x/:y.png`,
    async (req, reply) => {
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      if (!validParams(z, x, y)) return reply.code(404).send();

      const buf = await readTile(z, x, y, "heat");
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=0, s-maxage=86400")
        .header("ETag", `"heat-${z}-${x}-${y}-${buf.length}"`)
        .send(buf);
    },
  );
}
