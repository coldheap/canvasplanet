/**
 * The timelapse query: pixel_events in a bbox/time window, bucketed into
 * frames. Shared by the live player (routes/explore.ts) and the export job
 * queue (export/queue.ts) so both walk the exact same events in the exact
 * same order — an export must show what the player showed, not a
 * re-derived approximation.
 */
import {
  Terrain,
  TIMELAPSE_MAX_EVENTS,
  type PixelTuple,
  type TimelapseResponse,
} from "@worldcanvas/shared";
import { pool } from "../db/pool.js";
import { geo } from "../geo/index.js";

export interface TimelapseParams {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  from: number;
  to: number;
  frames: number;
}

export async function buildTimelapse(p: TimelapseParams): Promise<TimelapseResponse> {
  const { x0, y0, x1, y1, from, to, frames } = p;

  // Fetch one more than the cap so we can honestly report truncation
  // instead of silently returning a partial story.
  const { rows } = await pool.query<{
    x: number;
    y: number;
    color: number;
    prev_color: number | null;
    t: Date;
  }>(
    `SELECT x, y, color, prev_color, created_at AS t
       FROM pixel_events
      WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
        AND created_at >= to_timestamp($5 / 1000.0)
        AND created_at <  to_timestamp($6 / 1000.0)
      ORDER BY id ASC
      LIMIT $7`,
    [x0, x1, y0, y1, from, to, TIMELAPSE_MAX_EVENTS + 1],
  );
  const truncated = rows.length > TIMELAPSE_MAX_EVENTS;
  if (truncated) rows.length = TIMELAPSE_MAX_EVENTS;

  // `base` is the state at `from`: for each pixel, the prev_color of the
  // FIRST event that touched it in the window. Pixels never touched in the
  // window are not in base — the client draws them from the tile layer.
  const base: PixelTuple[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const key = r.x * 1_048_576 + r.y;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.prev_color !== null) base.push([r.x, r.y, r.prev_color]);
  }

  // Bucket into equal time slices.
  const span = to - from;
  const buckets: PixelTuple[][] = Array.from({ length: frames }, () => []);
  for (const r of rows) {
    const i = Math.min(frames - 1, Math.floor(((r.t.getTime() - from) / span) * frames));
    buckets[i]!.push([r.x, r.y, r.color]);
  }

  // One bit per pixel so a consumer can paint the still-unpainted ones as
  // sea or land instead of transparent, without shipping a byte per pixel.
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  const terrainBits = new Uint8Array(Math.ceil((tw * th) / 8));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (geo.lookup(x, y).terrain !== Terrain.Land) continue; // bit stays 0 (Water)
      const i = (y - y0) * tw + (x - x0);
      terrainBits[i >> 3]! |= 1 << (i & 7);
    }
  }

  return {
    bbox: { x0, y0, x1, y1 },
    from,
    to,
    base,
    frames: buckets.map((p2, i) => ({ t: from + ((i + 1) * span) / frames, p: p2 })),
    truncated,
    terrain: Buffer.from(terrainBits).toString("base64"),
  };
}
