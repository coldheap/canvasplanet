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
import { ERASED, tileAncestry } from "@worldcanvas/shared";
import { tx } from "../db/pool.js";
import { leaderboard } from "../leaderboard/store.js";
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

  return tx(async (c) => {
    // DISTINCT ON with ORDER BY id ASC gives the oldest matching event per
    // pixel — i.e. the state immediately before this incident began.
    const { rows } = await c.query<{
      x: number;
      y: number;
      prev_color: number | null;
      country_id: number;
    }>(
      `SELECT DISTINCT ON (x, y) x, y, prev_color, country_id
         FROM pixel_events
        WHERE ${clause}
        ORDER BY x, y, id ASC`,
      params,
    );

    if (sel.preview) {
      return { affected: rows.length, batchId: null, preview: true };
    }

    const batchId = randomUUID();

    for (const r of rows) {
      if (r.prev_color === null) {
        // The pixel was unpainted before the incident: remove it entirely.
        const del = await c.query<{ country_id: number }>(
          `DELETE FROM pixels WHERE x = $1 AND y = $2 RETURNING country_id`,
          [r.x, r.y],
        );
        const owner = del.rows[0]?.country_id;
        if (owner !== undefined) {
          await c.query(
            `UPDATE country_stats SET held = GREATEST(0, held - 1) WHERE country_id = $1`,
            [owner],
          );
        }
        // Tell watchers the pixel is gone. Without this the old colour stays
        // on screen until that tile happens to refresh, so a moderator
        // watching their own revert sees nothing happen for a couple of
        // seconds and reasonably concludes it failed.
        hub.publishPaint(r.x, r.y, ERASED, r.country_id);
      } else {
        await c.query(
          `UPDATE pixels
              SET color = $3, country_id = $4, staff_id = NULL, painted_at = now()
            WHERE x = $1 AND y = $2`,
          [r.x, r.y, r.prev_color, r.country_id],
        );
        hub.publishPaint(r.x, r.y, r.prev_color, r.country_id);
      }

      // Reverts are audited as paints so the history stays a complete record.
      await c.query(
        `INSERT INTO pixel_events (x, y, color, prev_color, country_id, staff_id, cost, batch_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 0, $6)`,
        [r.x, r.y, r.prev_color ?? 0, r.country_id, staffId, batchId],
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

    // Counters moved underneath the in-memory store; reload rather than try
    // to reconcile a bulk change increment by increment.
    await leaderboard.load();

    return { affected: rows.length, batchId, preview: false };
  });
}
