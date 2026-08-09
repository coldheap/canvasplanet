import { TILES_PER_AXIS, Z_PIXEL } from "@worldcanvas/shared";
import type { FastifyInstance } from "fastify";
import { readTile } from "../tiles/cache.js";

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
