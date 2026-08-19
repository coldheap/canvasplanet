/**
 * Admin image stamping.
 *
 * The client quantizes the image against the palette (shared/palette.ts) and
 * sends an array of palette indices, so this route validates and writes —
 * it never decodes an image. That keeps image parsing, the classic source of
 * memory-exhaustion bugs, off the server entirely.
 *
 * The whole stamp commits under ONE batch_id, so a misplaced 200x200 stamp
 * is a single-click revert rather than a cleanup job.
 */

import { randomUUID } from "node:crypto";
import {
  findProtecting,
  inPaintBounds,
  isValidColor,
  isViolation,
  tileAncestry,
} from "@canvasplanet/shared";
import { tx } from "../db/pool.js";
import { geo } from "../geo/index.js";
import { incrementCumulative, reloadOwnershipStores, transferHeld } from "../paint/ownership.js";
import { getProtectedRegions } from "../state/policy.js";
import { hub } from "../ws/hub.js";

/** Transparent pixels are skipped rather than painted. */
export const TRANSPARENT = 255;

export interface StampInput {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row-major palette indices, length w*h. 255 = leave the pixel alone. */
  data: number[];
  /** Count and validate without writing. Always offered before Apply. */
  preview?: boolean;
  /** Protect the stamped rectangle immediately after writing. */
  autoProtect?: boolean;
  name?: string;
}

export interface StampResult {
  pixels: number;
  violations: number;
  skippedProtected: number;
  skippedOutOfBounds: number;
  batchId: string | null;
  preview: boolean;
}

export const MAX_STAMP_DIM = 512;

export async function stamp(input: StampInput, staffId: number): Promise<StampResult> {
  const { x, y, w, h, data } = input;

  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw Object.assign(new Error("w and h must be positive integers"), { status: 400 });
  }
  if (w > MAX_STAMP_DIM || h > MAX_STAMP_DIM) {
    throw Object.assign(new Error(`stamp must be at most ${MAX_STAMP_DIM} pixels per side`), {
      status: 422,
    });
  }
  if (!Array.isArray(data) || data.length !== w * h) {
    throw Object.assign(new Error(`data must have exactly ${w * h} entries`), { status: 400 });
  }

  const regions = getProtectedRegions();
  const planned: Array<{ x: number; y: number; color: number; countryId: number; violating: boolean }> = [];
  let violations = 0;
  let skippedProtected = 0;
  let skippedOutOfBounds = 0;

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const color = data[dy * w + dx]!;
      if (color === TRANSPARENT) continue;
      if (!isValidColor(color)) {
        throw Object.assign(new Error(`invalid palette index ${color}`), { status: 400 });
      }

      const cx = x + dx;
      const cy = y + dy;
      if (!inPaintBounds(cx, cy)) {
        skippedOutOfBounds++;
        continue;
      }
      // Staff bypass the charge bank, but NOT protected regions — otherwise
      // an admin stamp could quietly obliterate the landmark or a memorial.
      // Overriding is a deliberate two-step: unprotect, stamp, re-protect.
      if (findProtecting(regions, cx, cy)) {
        skippedProtected++;
        continue;
      }

      const { countryId, terrain } = geo.lookup(cx, cy);
      const violating = isViolation(color, terrain);
      if (violating) violations++;
      planned.push({ x: cx, y: cy, color, countryId, violating });
    }
  }

  if (input.preview) {
    return {
      pixels: planned.length,
      violations,
      skippedProtected,
      skippedOutOfBounds,
      batchId: null,
      preview: true,
    };
  }

  const batchId = randomUUID();

  await tx(async (c) => {
    for (const pixel of planned) {
      const prev = await c.query<{
        color: number;
        country_id: number;
        alliance_id: number | null;
        user_id: number | null;
      }>(
        `SELECT color, country_id, alliance_id, user_id FROM pixels WHERE x = $1 AND y = $2 FOR UPDATE`,
        [pixel.x, pixel.y],
      );
      const prevRow = prev.rows[0] ?? null;

      await c.query(
        `INSERT INTO pixels (x, y, color, country_id, staff_id, painted_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (x, y) DO UPDATE
           SET color = EXCLUDED.color, country_id = EXCLUDED.country_id,
               alliance_id = NULL, user_id = NULL,
               staff_id = EXCLUDED.staff_id, session_id = NULL,
               painted_at = now(), paint_count = pixels.paint_count + 1`,
        [pixel.x, pixel.y, pixel.color, pixel.countryId, staffId],
      );

      await c.query(
        `INSERT INTO pixel_events
           (x, y, color, prev_color, country_id, staff_id, cost, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7)`,
        [pixel.x, pixel.y, pixel.color, prevRow?.color ?? null, pixel.countryId, staffId, batchId],
      );

      const previousOwner = prevRow
        ? { countryId: prevRow.country_id, allianceId: prevRow.alliance_id, userId: prevRow.user_id }
        : null;
      const nextOwner = { countryId: pixel.countryId, allianceId: null, userId: null };
      await transferHeld(c, previousOwner, nextOwner);
      await incrementCumulative(c, nextOwner);

      const chain = tileAncestry(pixel.x, pixel.y);
      await c.query(
        `INSERT INTO tile_dirty (z, x, y)
         SELECT * FROM UNNEST($1::smallint[], $2::int[], $3::int[])
         ON CONFLICT DO NOTHING`,
        [chain.map((t) => t.z), chain.map((t) => t.x), chain.map((t) => t.y)],
      );
    }

    if (input.autoProtect && planned.length > 0) {
      await c.query(
        `INSERT INTO protected_regions (name, x0, y0, x1, y1, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.name ?? `stamp ${batchId.slice(0, 8)}`, x, y, x + w - 1, y + h - 1, staffId],
      );
    }

    await c.query(
      `INSERT INTO audit_log (staff_id, action, params, affected)
       VALUES ($1, 'stamp', $2::jsonb, $3)`,
      [
        staffId,
        // Never log the pixel payload — it can be a quarter of a million
        // entries and the audit table is read on every admin page load.
        JSON.stringify({ x, y, w, h, violations, autoProtect: !!input.autoProtect, batchId }),
        planned.length,
      ],
    );
  });

  // Reconcile only after commit, then expose the committed canvas state.
  await reloadOwnershipStores();
  for (const pixel of planned) hub.publishPaint(pixel.x, pixel.y, pixel.color, pixel.countryId);

  return {
    pixels: planned.length,
    violations,
    skippedProtected,
    skippedOutOfBounds,
    batchId,
    preview: false,
  };
}
