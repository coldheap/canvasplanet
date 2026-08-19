/**
 * The revert engine — the 3am tool.
 *
 * Undoes vandalism using `pixel_events.prev_color`, so there is no replay
 * from zero. Three selectors, all reducing to the same core:
 *
 *   by area    — a bbox drawn on the live map
 *   by session — everything one painter did
 *   by time    — everything in the last N minutes
 *
 * For each affected pixel we take the *oldest* matching event and restore its
 * `prev_color`, which is the state before the vandalism started. Reverting
 * event-by-event newest-first would leave intermediate vandal colours behind
 * wherever a pixel was hit more than once.
 *
 * A revert is itself recorded as events with a fresh `batch_id`, so a revert
 * can be reverted.
 *
 * `staffId` is nullable: the corruption event engine (ROADMAP.md Phase 7,
 * events/engine.ts) calls this programmatically to auto-revert a zone when
 * its timer ends, with no staff member behind it — the nullable columns it
 * writes into (pixel_events.staff_id, audit_log.staff_id) already allow this,
 * same as an ordinary anonymous paint.
 */

import { randomUUID } from "node:crypto";
import { ERASED, tileAncestry } from "@canvasplanet/shared";
import { tx } from "../db/pool.js";
import { reloadOwnershipStores, transferHeld, type PixelOwnership } from "../paint/ownership.js";
import { hub } from "../ws/hub.js";

export interface RevertSelector {
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  sessionId?: number;
  /** Epoch ms; events at or after this are reverted. */
  since?: number;
  /** Only count, do not write. Always offered in the UI before Apply. */
  preview?: boolean;
}

export interface RevertResult {
  affected: number;
  batchId: string | null;
  preview: boolean;
}

export async function revert(sel: RevertSelector, staffId: number | null): Promise<RevertResult> {
  if (!sel.bbox && sel.sessionId === undefined && sel.since === undefined) {
    throw new Error("revert requires at least one selector");
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (sel.bbox) {
    params.push(sel.bbox.x0, sel.bbox.x1, sel.bbox.y0, sel.bbox.y1);
    where.push(`x BETWEEN $${params.length - 3} AND $${params.length - 2}`);
    where.push(`y BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (sel.sessionId !== undefined) {
    params.push(sel.sessionId);
    where.push(`session_id = $${params.length}`);
  }
  if (sel.since !== undefined) {
    params.push(new Date(sel.since));
    where.push(`created_at >= $${params.length}`);
  }
  const clause = where.join(" AND ");

  const outcome = await tx(async (c) => {
    // DISTINCT ON with ORDER BY id ASC gives the oldest matching event per
    // pixel — i.e. the state immediately before this incident began.
    const { rows } = await c.query<{
      x: number;
      y: number;
      prev_color: number | null;
      country_id: number;
      restore_country_id: number | null;
      restore_alliance_id: number | null;
      restore_user_id: number | null;
      restore_session_id: number | null;
      restore_staff_id: number | null;
    }>(
      `WITH targets AS (
         SELECT DISTINCT ON (x, y) id, x, y, prev_color, country_id
           FROM pixel_events
          WHERE ${clause}
          ORDER BY x, y, id ASC
       )
       SELECT t.x, t.y, t.prev_color, t.country_id,
              prior.country_id AS restore_country_id,
              prior.alliance_id AS restore_alliance_id,
              prior.user_id AS restore_user_id,
              prior.session_id AS restore_session_id,
              prior.staff_id AS restore_staff_id
         FROM targets t
         LEFT JOIN LATERAL (
           SELECT country_id, alliance_id, user_id, session_id, staff_id
             FROM pixel_events p
            WHERE p.x = t.x AND p.y = t.y AND p.id < t.id
            ORDER BY p.id DESC
            LIMIT 1
         ) prior ON true`,
      params,
    );

    if (sel.preview) {
      return {
        result: { affected: rows.length, batchId: null, preview: true } satisfies RevertResult,
        publishes: [] as Array<{ x: number; y: number; color: number; countryId: number }>,
      };
    }

    const batchId = randomUUID();
    const publishes: Array<{ x: number; y: number; color: number; countryId: number }> = [];

    for (const r of rows) {
      const current = await c.query<{
        color: number;
        country_id: number;
        alliance_id: number | null;
        user_id: number | null;
      }>(
        `SELECT color, country_id, alliance_id, user_id
           FROM pixels WHERE x = $1 AND y = $2 FOR UPDATE`,
        [r.x, r.y],
      );
      const currentRow = current.rows[0] ?? null;
      const currentOwner: PixelOwnership | null = currentRow
        ? {
            countryId: currentRow.country_id,
            allianceId: currentRow.alliance_id,
            userId: currentRow.user_id,
          }
        : null;
      const restoreCountryId = r.restore_country_id ?? r.country_id;
      const restoredOwner: PixelOwnership | null =
        r.prev_color === null
          ? null
          : {
              countryId: restoreCountryId,
              allianceId: r.restore_alliance_id,
              userId: r.restore_user_id,
            };

      if (r.prev_color === null) {
        // The pixel was unpainted before the incident: remove it entirely.
        await c.query(`DELETE FROM pixels WHERE x = $1 AND y = $2`, [r.x, r.y]);
        publishes.push({
          x: r.x,
          y: r.y,
          color: ERASED,
          countryId: currentRow?.country_id ?? r.country_id,
        });
      } else {
        await c.query(
          `INSERT INTO pixels
             (x, y, color, country_id, alliance_id, user_id, session_id, staff_id, painted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
           ON CONFLICT (x, y) DO UPDATE
             SET color = EXCLUDED.color,
                 country_id = EXCLUDED.country_id,
                 alliance_id = EXCLUDED.alliance_id,
                 user_id = EXCLUDED.user_id,
                 session_id = EXCLUDED.session_id,
                 staff_id = EXCLUDED.staff_id,
                 painted_at = now(),
                 paint_count = pixels.paint_count + 1`,
          [
            r.x,
            r.y,
            r.prev_color,
            restoreCountryId,
            r.restore_alliance_id,
            r.restore_user_id,
            r.restore_session_id,
            r.restore_staff_id,
          ],
        );
        publishes.push({ x: r.x, y: r.y, color: r.prev_color, countryId: restoreCountryId });
      }

      await transferHeld(c, currentOwner, restoredOwner);

      // Reverts are audited as paints so the history stays a complete record.
      await c.query(
        `INSERT INTO pixel_events
           (x, y, color, prev_color, country_id, alliance_id, user_id, session_id, staff_id, cost, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10)`,
        [
          r.x,
          r.y,
          r.prev_color ?? ERASED,
          currentRow?.color ?? null,
          restoreCountryId,
          r.restore_alliance_id,
          r.restore_user_id,
          r.restore_session_id,
          r.restore_staff_id,
          batchId,
        ],
      );

      const chain = tileAncestry(r.x, r.y);
      await c.query(
        `INSERT INTO tile_dirty (z, x, y)
         SELECT * FROM UNNEST($1::smallint[], $2::int[], $3::int[])
         ON CONFLICT DO NOTHING`,
        [chain.map((t) => t.z), chain.map((t) => t.x), chain.map((t) => t.y)],
      );
    }

    await c.query(
      `INSERT INTO audit_log (staff_id, action, params, affected)
       VALUES ($1, 'revert', $2::jsonb, $3)`,
      [staffId, JSON.stringify(sel), rows.length],
    );

    return {
      result: { affected: rows.length, batchId, preview: false } satisfies RevertResult,
      publishes,
    };
  });

  if (!outcome.result.preview) {
    // DB state must be visible before stores reload and sockets hear about it.
    await reloadOwnershipStores();
    for (const p of outcome.publishes) hub.publishPaint(p.x, p.y, p.color, p.countryId);
  }
  return outcome.result;
}
