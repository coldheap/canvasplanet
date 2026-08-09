import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { BASEMAP_MAX_ZOOM } from "@worldcanvas/shared";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";

/**
 * The pre-baked land/ocean backdrop (see `pnpm geo:bake-basemap`) — static
 * files on disk, never rendered on demand. A tile that hasn't been baked
 * (bad z/x/y, or the bake hasn't run) 404s; there's no on-the-fly fallback
 * the way tiles.ts has, because there's nothing derivable from at request
 * time the way pixel tiles derive from the `pixels` table.
 */
function validParams(z: number, x: number, y: number): boolean {
  const max = 2 ** z;
  return (
    Number.isInteger(z) &&
    z >= 0 &&
    z <= BASEMAP_MAX_ZOOM &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < max &&
    y < max
  );
}

export function registerBasemapRoutes(app: FastifyInstance): void {
  app.get<{ Params: { z: string; x: string; y: string } }>(
    "/basemap/:z/:x/:y.png",
    async (req, reply) => {
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      if (!validParams(z, x, y)) return reply.code(404).send();

      try {
        const buf = await readFile(join(env.basemapDir, String(z), String(x), `${y}.png`));
        return reply
          .header("Content-Type", "image/png")
          // Long-lived: this only changes when someone re-runs the bake, an
          // infrequent manual step, not a live-data cache the way tiles.ts's
          // pixel canvas is.
          .header("Cache-Control", "public, max-age=86400, s-maxage=604800")
          .send(buf);
      } catch {
        return reply.code(404).send();
      }
    },
  );
}
