/**
 * The timelapse query: state at the requested start plus pixel_events in the
 * bbox/time window, bucketed into frames. Shared by live playback and export.
 */
import {
  ERASED,
  Terrain,
  TIMELAPSE_MAX_EVENTS,
  type PixelTuple,
  type TimelapseResponse,
} from "@canvasplanet/shared";
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
  if (!Number.isInteger(frames) || frames < 1) throw new Error("frames must be a positive integer");

  // Base and deltas come from one statement so both observe the same MVCC
  // snapshot. The base deliberately includes pixels untouched in the window;
  // deriving it only from in-window prev_color values lost established art.
  const { rows: stateRows } = await pool.query<{
    x: number;
    y: number;
    color: number;
    t: Date | null;
    event_id: number | null;
    is_base: boolean;
  }>(
    `WITH base AS (
       SELECT DISTINCT ON (x, y) x, y, color
         FROM pixel_events
        WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
          AND created_at < to_timestamp($5 / 1000.0)
        ORDER BY x, y, id DESC
     ), window_events AS (
       SELECT id, x, y, color, created_at
         FROM pixel_events
        WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
          AND created_at >= to_timestamp($5 / 1000.0)
          AND created_at <  to_timestamp($6 / 1000.0)
        ORDER BY id ASC
        LIMIT $7
     )
     SELECT x, y, color, NULL::timestamptz AS t, NULL::bigint AS event_id, true AS is_base FROM base
     UNION ALL
     SELECT x, y, color, created_at, id, false FROM window_events`,
    [x0, x1, y0, y1, from, to, TIMELAPSE_MAX_EVENTS + 1],
  );

  const rows = stateRows
    .filter((r) => !r.is_base)
    .sort((a, b) => a.event_id! - b.event_id!) as Array<
    (typeof stateRows)[number] & { t: Date; event_id: number; is_base: false }
  >;
  const truncated = rows.length > TIMELAPSE_MAX_EVENTS;
  if (truncated) rows.length = TIMELAPSE_MAX_EVENTS;

  const base: PixelTuple[] = stateRows
    .filter((r) => r.is_base)
    .filter((r) => r.color !== ERASED)
    .map((r) => [r.x, r.y, r.color]);

  const span = to - from;
  const buckets: PixelTuple[][] = Array.from({ length: frames }, () => []);
  for (const r of rows) {
    const i = Math.min(frames - 1, Math.floor(((r.t.getTime() - from) / span) * frames));
    buckets[i]!.push([r.x, r.y, r.color]);
  }

  // One terrain bit per pixel lets consumers draw unpainted cells as water or
  // land rather than transparent without shipping a byte per pixel.
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  const terrainBits = new Uint8Array(Math.ceil((tw * th) / 8));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (geo.lookup(x, y).terrain !== Terrain.Land) continue;
      const i = (y - y0) * tw + (x - x0);
      terrainBits[i >> 3]! |= 1 << (i & 7);
    }
  }

  return {
    bbox: { x0, y0, x1, y1 },
    from,
    to,
    base,
    frames: buckets.map((pixels, i) => ({ t: from + ((i + 1) * span) / frames, p: pixels })),
    truncated,
    terrain: Buffer.from(terrainBits).toString("base64"),
  };
}
