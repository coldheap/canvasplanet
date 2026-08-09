/**
 * The area-report queue — the input side of moderation.
 *
 * A report is just a bbox plus an optional reason; the tooling to act on it
 * (revert, ban) already exists in admin/revert.ts and routes/admin.ts. This
 * file is the small amount of glue specific to the queue itself: rendering a
 * thumbnail on demand (never stored — a moderator reviewing hours later
 * should see the area's *current* state, not a snapshot from submission
 * time) and surfacing who has been painting there recently, so "revert" and
 * "ban" are one click away instead of a trip through the forensic inspector.
 */

import { PNG } from "pngjs";
import { DEFAULT_TERRAIN_COLOR, PALETTE_RGB, TEMPLATE_MAX_DIM } from "@worldcanvas/shared";
import { pool } from "../db/pool.js";
import { geo } from "../geo/index.js";

export interface ReportSelector {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  reason?: string;
}

const REASON_MAX_LEN = 500;

/** Same cap as a template/region read — the largest area anything may ask
 *  about in one request, so a report can never become an expensive query. */
export function normalizeSelector(
  body: Partial<ReportSelector>,
): ReportSelector | { error: string; status: 400 | 422 } {
  const x0 = Math.min(Number(body.x0), Number(body.x1));
  const x1 = Math.max(Number(body.x0), Number(body.x1));
  const y0 = Math.min(Number(body.y0), Number(body.y1));
  const y1 = Math.max(Number(body.y0), Number(body.y1));
  if (![x0, x1, y0, y1].every(Number.isInteger)) {
    return { error: "x0,y0,x1,y1 must be integers", status: 400 };
  }
  if (x1 - x0 + 1 > TEMPLATE_MAX_DIM || y1 - y0 + 1 > TEMPLATE_MAX_DIM) {
    return { error: `reported area must be at most ${TEMPLATE_MAX_DIM} pixels per side`, status: 422 };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, REASON_MAX_LEN) : undefined;
  return { x0, y0, x1, y1, reason: reason || undefined };
}

const THUMB_MAX_DIM = 220;

/**
 * A live thumbnail of a bbox, downsampled nearest-pixel (last write wins per
 * output cell) rather than box-filtered — this is a moderator's "does this
 * look like vandalism" glance, not a rendered artifact, so exact averaging
 * buys nothing worth the extra CPU.
 */
export async function renderReportThumbnail(x0: number, y0: number, x1: number, y1: number): Promise<Buffer> {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const scale = Math.max(1, Math.ceil(Math.max(w, h) / THUMB_MAX_DIM));
  const tw = Math.ceil(w / scale);
  const th = Math.ceil(h / scale);

  const { rows } = await pool.query<{ x: number; y: number; color: number }>(
    `SELECT x, y, color FROM pixels WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4`,
    [x0, x1, y0, y1],
  );

  const png = new PNG({ width: tw, height: th });
  // Background first: each output cell reads as the terrain it actually is
  // (sea or land), sampled at its centre pixel, rather than transparent —
  // a moderator should see "empty ocean", not a hole in the thumbnail.
  for (let py = 0; py < th; py++) {
    for (let px = 0; px < tw; px++) {
      const wx = Math.min(x1, x0 + px * scale + (scale >> 1));
      const wy = Math.min(y1, y0 + py * scale + (scale >> 1));
      const rgb = PALETTE_RGB[DEFAULT_TERRAIN_COLOR[geo.lookup(wx, wy).terrain]]!;
      const o = (py * tw + px) * 4;
      png.data[o] = rgb[0];
      png.data[o + 1] = rgb[1];
      png.data[o + 2] = rgb[2];
      png.data[o + 3] = 255;
    }
  }
  for (const r of rows) {
    const rgb = PALETTE_RGB[r.color];
    if (!rgb) continue;
    const px = Math.floor((r.x - x0) / scale);
    const py = Math.floor((r.y - y0) / scale);
    const o = (py * tw + px) * 4;
    png.data[o] = rgb[0];
    png.data[o + 1] = rgb[1];
    png.data[o + 2] = rgb[2];
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

export interface Suspect {
  sessionId: number;
  ip: string | null;
  paints: number;
}

/**
 * Who has painted inside this bbox recently, most active first. Scoped to
 * the last 24h so a report against a long-settled area does not surface
 * whoever happened to place the base layer months ago.
 */
export async function reportSuspects(x0: number, y0: number, x1: number, y1: number): Promise<Suspect[]> {
  const { rows } = await pool.query<{ session_id: number | null; ip: string | null; n: number }>(
    `SELECT session_id, ip::text AS ip, count(*)::int AS n
       FROM pixel_events
      WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
        AND created_at > now() - interval '24 hours'
        AND session_id IS NOT NULL
      GROUP BY session_id, ip
      ORDER BY n DESC
      LIMIT 5`,
    [x0, x1, y0, y1],
  );
  return rows.map((r) => ({ sessionId: r.session_id!, ip: r.ip, paints: r.n }));
}
