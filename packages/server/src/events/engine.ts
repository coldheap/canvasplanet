/**
 * The corruption event engine (ROADMAP.md Phase 7) — a recurring vs-server
 * contest.
 *
 * On a fixed interval a bot session starts painting a random small zone a
 * fixed "corruption" colour at a steady tick. The zone is cleared to
 * unclaimed ground first, and player-held pixels then cost the bot twice its
 * normal tick budget to retake. Any ordinary player paint inside the zone
 * with a different colour counts as defence — there is no special pixel
 * type, attribution works exactly like any other paint
 * (routes/paint.ts calls applyPaint() after every commit, same as the
 * leaderboard/alliance/player stores). When the timer ends the whole zone
 * plus a small cleanup margin is reverted to its pre-event state, win or
 * lose, via admin/revert.ts —
 * nothing about this event survives on the canvas either way;
 * corruption_events (migration 0014) is the only permanent record.
 *
 * Follows leaderboard/store.ts's shape: a single in-memory instance, a
 * tick() polled by the hub's 1Hz array (index.ts), broadcasting a message
 * when there's something to say. Unlike those stores this one is "dirty"
 * for an event's whole duration (the countdown moves every second), not
 * just on a state change — it returns non-null continuously while active
 * and broadcasts directly (not through tick()) on the two edges, start and
 * resolve, so every client updates the instant either happens rather than
 * waiting up to a second.
 *
 * The actual corruption/defence arithmetic lives in events/state.ts
 * (ActiveEventState), kept pure and DB-free so it's unit-testable the way
 * economy.ts is — everything below is the I/O around it.
 *
 * resolveEvent() closes the zone to new player writes, waits for both player
 * and bot writes already in flight, then reverts twice as a defensive mop-up.
 * See resolveEvent()'s own comments before changing that ordering.
 */

import { randomUUID } from "node:crypto";
import {
  bboxContains,
  bboxOverlaps,
  ERASED,
  EVENT_BONUS_DURATION_MS,
  EVENT_BOT_COLOR,
  EVENT_BOT_PIXELS_PER_TICK,
  EVENT_ZONE_SIZE,
  PAINT_BOUNDS,
  tileAncestry,
  WORLD_SIZE,
  type Bbox,
  type EventStateDTO,
  type ServerMessage,
} from "@canvasplanet/shared";
import { revert } from "../admin/revert.js";
import { alliances } from "../alliances/store.js";
import { pool, tx } from "../db/pool.js";
import { env } from "../env.js";
import { geo } from "../geo/index.js";
import { leaderboard } from "../leaderboard/store.js";
import { incrementCumulative, reloadOwnershipStores, transferHeld } from "../paint/ownership.js";
import { players } from "../players/store.js";
import { getProtectedRegions, isFrozen } from "../state/policy.js";
import { hub } from "../ws/hub.js";
import { ActiveEventState, botPaintWorkCost, eventRollbackBbox } from "./state.js";

export interface EventHistoryRow {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  bot_color: number;
  started_at: string;
  ends_at: string;
  resolved_at: string | null;
  result: "defended" | "corrupted" | "aborted" | null;
  corruption_pct: number | null;
  defenders: number;
}

/** How long the mop-up revert pass in resolveEvent() waits before re-running
 *  — see that method's doc comment for why a second pass exists at all. */
const REVERT_MOPUP_DELAY_MS = 2_000;

interface InFlightPlayerPaint {
  x: number;
  y: number;
  done: Promise<void>;
}

interface ClearedPixel {
  x: number;
  y: number;
  color: number;
  country_id: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EventEngine {
  private active: ActiveEventState | null = null;
  private nextAt = Date.now() + env.eventIntervalMs;
  private starting = false;
  private resolving = false;
  private botTicking = false;
  /** Briefly closes the chosen square while its pre-event contents are
   * recorded and cleared. The event is not exposed to clients until that
   * transaction has committed. */
  private preparingBbox: Bbox | null = null;
  /** The in-flight botTick(), if any — resolveEvent() awaits this before
   *  reverting so the bot's own last writes can't land after the revert's
   *  SELECT already fixed its result set. See botTick()'s doc comment. */
  private botTickPromise: Promise<void> | null = null;
  /** Every paint request is registered before its transaction starts. This
   *  lets resolution wait for the exact requests touching its zone, including
   *  one that began just before the event itself started. */
  private playerPaints = new Set<InFlightPlayerPaint>();

  /**
   * Reverts any event left unresolved by a server restart — the "zero
   * permanent trace" promise has to hold even across a crash mid-event.
   * Call once at boot, after state/policy.ts has loaded protected regions
   * (revert doesn't need them, but this keeps boot order legible).
   */
  async recoverOnBoot(): Promise<void> {
    const { rows } = await pool.query<{
      id: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      started_at: Date;
    }>(`SELECT id, x0, y0, x1, y1, started_at FROM corruption_events WHERE resolved_at IS NULL`);

    for (const r of rows) {
      console.warn(`[events] reverting unresolved event ${r.id} left over from a restart`);
      await revert(
        {
          bbox: eventRollbackBbox({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }),
          since: r.started_at.getTime(),
        },
        null,
      );
      await pool.query(
        `UPDATE corruption_events SET resolved_at = now(), result = 'aborted' WHERE id = $1`,
        [r.id],
      );
    }
    this.nextAt = Date.now() + env.eventIntervalMs;
  }

  /**
   * Called on the 1Hz hub tick (index.ts). Cheap and synchronous — starting
   * a new event and resolving a finished one are async DB work, kicked off
   * but not awaited here, each guarded so an in-flight one never starts
   * twice from two ticks landing close together.
   */
  tick(): ServerMessage | null {
    const now = Date.now();
    const ev = this.active;

    if (ev) {
      if (now >= ev.endsAt) {
        if (!this.resolving) {
          this.resolving = true;
          ev.beginResolving();
          void this.resolveEvent(ev).finally(() => {
            this.resolving = false;
          });
        }
        // Keep pushing the resolution state while canvas restoration runs.
        // A client must never be left looking at an active event stuck at 0:00.
        return { t: "event", event: ev.toDTO() };
      }
      if (!this.botTicking) {
        this.botTicking = true;
        this.botTickPromise = this.botTick(ev).finally(() => {
          this.botTicking = false;
          this.botTickPromise = null;
        });
      }
      return { t: "event", event: ev.toDTO() };
    }

    if (!this.starting && now >= this.nextAt) {
      this.starting = true;
      void this.startEvent().finally(() => {
        this.starting = false;
      });
    }
    return null;
  }

  /**
   * Called from routes/paint.ts after every successful commit. Zero cost
   * when no event is running or the pixel is outside the zone — the same
   * discipline as findProtecting() on the paint path itself.
   */
  applyPaint(x: number, y: number, color: number, sessionId: number): void {
    const ev = this.active;
    if (!ev || !ev.contains(x, y)) return;
    ev.notePaint(x, y, color, sessionId);
  }

  /** Registers a player paint before its DB transaction. Null means the
   *  deadline has passed and this zone is closed until rollback completes. */
  beginPlayerPaint(x: number, y: number): (() => void) | null {
    if (this.preparingBbox && bboxContains(this.preparingBbox, x, y)) return null;

    const ev = this.active;
    if (ev?.containsRollbackArea(x, y) && (ev.isResolving() || Date.now() >= ev.endsAt)) return null;

    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry = { x, y, done };
    this.playerPaints.add(entry);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.playerPaints.delete(entry);
      finish();
    };
  }

  /** For bootstrap.ts — a reconnecting/late-joining client's first look. */
  current(): EventStateDTO | null {
    return this.active?.toDTO() ?? null;
  }

  /** Admin-only manual end (the Events tab's force-end button) — same
   *  resolve path, judged on whatever the corruption % happens to be now. */
  async forceEnd(): Promise<boolean> {
    const ev = this.active;
    if (!ev || this.resolving) return false;
    this.resolving = true;
    ev.beginResolving();
    try {
      await this.resolveEvent(ev);
      return true;
    } finally {
      this.resolving = false;
    }
  }

  async history(limit = 20): Promise<EventHistoryRow[]> {
    const { rows } = await pool.query<EventHistoryRow>(
      `SELECT id, x0, y0, x1, y1, bot_color, started_at, ends_at, resolved_at, result,
              corruption_pct, defenders
         FROM corruption_events
        ORDER BY id DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  // -------------------------------------------------------------------------

  /** Purely random within the paint-bounds scope gate, skipping any zone
   *  that overlaps a protected region — the roadmap's own framing, not
   *  biased toward populated land. Regions are sparse relative to a
   *  1M x 1M (or scoped) world, so a handful of retries is enough; if every
   *  attempt loses, this cycle is skipped and the next tick tries again —
   *  cheap, since nothing here touches the database. */
  private pickZone(): Bbox | null {
    const bounds = PAINT_BOUNDS ?? { x0: 0, y0: 0, x1: WORLD_SIZE - 1, y1: WORLD_SIZE - 1 };
    const span = EVENT_ZONE_SIZE;
    const maxX0 = bounds.x1 - bounds.x0 + 1 - span;
    const maxY0 = bounds.y1 - bounds.y0 + 1 - span;
    if (maxX0 < 0 || maxY0 < 0) return null;

    const regions = getProtectedRegions();
    for (let attempt = 0; attempt < 30; attempt++) {
      const x0 = bounds.x0 + Math.floor(Math.random() * (maxX0 + 1));
      const y0 = bounds.y0 + Math.floor(Math.random() * (maxY0 + 1));
      const candidate: Bbox = { x0, y0, x1: x0 + span - 1, y1: y0 + span - 1 };
      if (!regions.some((r) => bboxOverlaps(r, eventRollbackBbox(candidate)))) return candidate;
    }
    return null;
  }

  private async startEvent(): Promise<void> {
    // A frozen canvas means nobody can paint at all — starting a contest
    // defenders are structurally unable to respond to would not be a fair
    // fight. nextAt is left untouched, so this is retried every tick until
    // the freeze lifts, the same "just try again next tick" shape as a
    // failed zone pick just below.
    if (isFrozen()) return;

    const bbox = this.pickZone();
    if (!bbox) return; // try again next tick

    this.preparingBbox = bbox;
    try {
      // Drain requests that registered just before the square closed. Without
      // this boundary, one could commit between the clear's SELECT and DELETE
      // and either survive the clear or be erased without joining the event.
      const pending = [...this.playerPaints]
        .filter((paint) => bboxContains(bbox, paint.x, paint.y))
        .map((paint) => paint.done);
      await Promise.all(pending);

      const batchId = randomUUID();
      const created = await this.createAndClearEvent(bbox, batchId);

      // Establish in-memory authority immediately after the durable clear.
      // Store reloads and socket publication are follow-up visibility work;
      // if either fails, the next tick must continue this event rather than
      // start a second one over an unresolved database row.
      this.active = new ActiveEventState(
        created.id,
        bbox,
        EVENT_BOT_COLOR,
        created.startedAt,
        created.endsAt,
        batchId,
      );
      if (created.pixels.length > 0) {
        await reloadOwnershipStores();
        for (const pixel of created.pixels) hub.publishPaint(pixel.x, pixel.y, ERASED, pixel.country_id);
      }
      console.log(
        `[events] corruption event ${this.active.id} started at (${bbox.x0},${bbox.y0})-(${bbox.x1},${bbox.y1}), cleared ${created.pixels.length} pixels, ends in ${env.eventDurationMs}ms`,
      );
      hub.broadcast({ t: "event", event: this.active.toDTO() });
    } finally {
      this.preparingBbox = null;
    }
  }

  /** Records the event and turns its square into genuinely unclaimed ground
   * in one transaction. The erase history is what lets the normal revert
   * engine reconstruct every pre-event colour and owner at resolution. */
  private async createAndClearEvent(
    bbox: Bbox,
    batchId: string,
  ): Promise<{ id: number; startedAt: number; endsAt: number; pixels: ClearedPixel[] }> {
    const outcome = await tx(async (c) => {
      const event = await c.query<{ id: number; started_at: Date; ends_at: Date }>(
        `INSERT INTO corruption_events (x0, y0, x1, y1, bot_color, started_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + ($6 * interval '1 millisecond'))
         RETURNING id, started_at, ends_at`,
        [bbox.x0, bbox.y0, bbox.x1, bbox.y1, EVENT_BOT_COLOR, env.eventDurationMs],
      );

      const { rows } = await c.query<ClearedPixel>(
        `WITH cleared AS (
           DELETE FROM pixels
            WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
            RETURNING x, y, color, country_id, alliance_id, user_id
         ),
         history AS (
           INSERT INTO pixel_events (x, y, color, prev_color, country_id, cost, batch_id)
           SELECT x, y, $5, color, country_id, 0, $6 FROM cleared
           RETURNING 1
         ),
         country_loss AS (
           UPDATE country_stats stats
              SET held = GREATEST(0, stats.held - loss.amount)
             FROM (
               SELECT country_id, COUNT(*)::int AS amount FROM cleared GROUP BY country_id
             ) loss
            WHERE stats.country_id = loss.country_id
           RETURNING 1
         ),
         alliance_loss AS (
           UPDATE alliance_stats stats
              SET held = GREATEST(0, stats.held - loss.amount)
             FROM (
               SELECT alliance_id, COUNT(*)::int AS amount
                 FROM cleared WHERE alliance_id IS NOT NULL GROUP BY alliance_id
             ) loss
            WHERE stats.alliance_id = loss.alliance_id
           RETURNING 1
         ),
         user_loss AS (
           UPDATE user_stats stats
              SET held = GREATEST(0, stats.held - loss.amount)
             FROM (
               SELECT user_id, COUNT(*)::int AS amount
                 FROM cleared WHERE user_id IS NOT NULL GROUP BY user_id
             ) loss
            WHERE stats.user_id = loss.user_id
           RETURNING 1
         )
         SELECT x, y, color, country_id FROM cleared`,
        [bbox.x0, bbox.x1, bbox.y0, bbox.y1, ERASED, batchId],
      );

      if (rows.length > 0) {
        const dirty = rows.flatMap((pixel) => tileAncestry(pixel.x, pixel.y));
        await c.query(
          `INSERT INTO tile_dirty (z, x, y)
           SELECT * FROM UNNEST($1::smallint[], $2::int[], $3::int[])
           ON CONFLICT DO NOTHING`,
          [dirty.map((tile) => tile.z), dirty.map((tile) => tile.x), dirty.map((tile) => tile.y)],
        );
      }

      return {
        id: event.rows[0]!.id,
        startedAt: event.rows[0]!.started_at.getTime(),
        endsAt: event.rows[0]!.ends_at.getTime(),
        pixels: rows,
      };
    });

    return outcome;
  }

  /**
   * The bot's brush stroke: EVENT_BOT_PIXELS_PER_TICK work units per
   * LB_TICK_MS. Clean/server-held ground costs one; player-held ground costs
   * two. The writes otherwise have admin/stamp.ts's shape (staff bypass — no
   * charges or alliance/user attribution) and are applied incrementally.
   *
   * `botTicking`/`botTickPromise` bookkeeping lives in the caller (tick()),
   * not here — resolveEvent() needs to await the exact promise a still-running
   * call returns, not just a boolean, so a bot write started just before the
   * timer ended can't commit after revert()'s SELECT already ran and survive
   * the revert (the bug this fixes: a corruption event occasionally left a
   * handful of black pixels and/or a defender's own paint un-reverted).
   */
  private async botTick(ev: ActiveEventState): Promise<void> {
    // Same reasoning as the freeze check in startEvent: a frozen canvas
    // pauses the bot too rather than let it grind on uncontested while
    // nobody can defend.
    if (isFrozen()) return;
    let workSpent = 0;
    let attempts = 0;
    while (workSpent < EVENT_BOT_PIXELS_PER_TICK && attempts < EVENT_BOT_PIXELS_PER_TICK) {
      attempts++;
      const x = ev.bbox.x0 + Math.floor(Math.random() * EVENT_ZONE_SIZE);
      const y = ev.bbox.y0 + Math.floor(Math.random() * EVENT_ZONE_SIZE);
      const { countryId } = geo.lookup(x, y);

      const painted = await tx(async (c) => {
        const prev = await c.query<{
          color: number;
          country_id: number;
          alliance_id: number | null;
          user_id: number | null;
          session_id: number | null;
        }>(
          `SELECT color, country_id, alliance_id, user_id, session_id
             FROM pixels WHERE x = $1 AND y = $2 FOR UPDATE`,
          [x, y],
        );
        const prevRow = prev.rows[0] ?? null;
        const workCost = botPaintWorkCost(prevRow?.session_id ?? null);
        if (workSpent + workCost > EVENT_BOT_PIXELS_PER_TICK) return null;

        await c.query(
          `INSERT INTO pixels (x, y, color, country_id, painted_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (x, y) DO UPDATE
             SET color = EXCLUDED.color, country_id = EXCLUDED.country_id,
                 alliance_id = NULL, user_id = NULL, session_id = NULL, staff_id = NULL,
                 painted_at = now(), paint_count = pixels.paint_count + 1`,
          [x, y, ev.botColor, countryId],
        );
        await c.query(
          `INSERT INTO pixel_events (x, y, color, prev_color, country_id, cost, batch_id)
           VALUES ($1, $2, $3, $4, $5, 0, $6)`,
          [x, y, ev.botColor, prevRow?.color ?? null, countryId, ev.batchId],
        );
        const previousOwner = prevRow
          ? { countryId: prevRow.country_id, allianceId: prevRow.alliance_id, userId: prevRow.user_id }
          : null;
        const nextOwner = { countryId, allianceId: null, userId: null };
        await transferHeld(c, previousOwner, nextOwner);
        await incrementCumulative(c, nextOwner);
        const chain = tileAncestry(x, y);
        await c.query(
          `INSERT INTO tile_dirty (z, x, y)
           SELECT * FROM UNNEST($1::smallint[], $2::int[], $3::int[])
           ON CONFLICT DO NOTHING`,
          [chain.map((t) => t.z), chain.map((t) => t.x), chain.map((t) => t.y)],
        );

        return { prevRow, workCost };
      });

      if (!painted) continue;
      workSpent += painted.workCost;
      hub.publishPaint(x, y, ev.botColor, countryId);
      leaderboard.applySystemPaint();
      alliances.applyPaint(null, painted.prevRow?.alliance_id ?? null);
      players.applyPaint(null, painted.prevRow?.user_id ?? null);
      ev.notePaint(x, y, ev.botColor, null);
    }
  }

  private async resolveEvent(ev: ActiveEventState): Promise<void> {
    // A bot write started on the previous hub tick can still be mid-flight
    // when this one decides the timer's up — awaiting it here means its
    // pixels are (a) counted in the judgment below and (b) actually gone by
    // the time revert()'s SELECT runs, rather than committing just after and
    // surviving the revert. This was the reproducible half of the bug report:
    // "some black corruption pixels weren't rolled back."
    const playerPaints = [...this.playerPaints]
      .filter((paint) => ev.containsRollbackArea(paint.x, paint.y))
      .map((paint) => paint.done);
    await Promise.all([...(this.botTickPromise ? [this.botTickPromise] : []), ...playerPaints]);

    const pct = ev.corruptionPct();
    const result = ev.resolve();
    // The winner is known now; canvas restoration can take a few seconds and
    // must not hide that outcome behind a frozen countdown.
    hub.broadcast({ t: "event", event: ev.toDTO() });

    // Zero permanent trace either way — see migration 0014's header comment.
    const rollbackBbox = eventRollbackBbox(ev.bbox);
    await revert({ bbox: rollbackBbox, since: ev.startedAt }, null);

    // The other half of the bug report — "pixels I placed myself weren't
    // rolled back": beginPlayerPaint() now closes the zone and the await above
    // drains already-started player transactions before the first pass. Keep
    // this short-delayed second pass as a defensive mop-up for any non-player
    // write path; revert() is idempotent.
    await sleep(REVERT_MOPUP_DELAY_MS);
    await revert({ bbox: rollbackBbox, since: ev.startedAt }, null);

    await pool.query(
      `UPDATE corruption_events
          SET resolved_at = now(), result = $2, corruption_pct = $3, defenders = $4
        WHERE id = $1`,
      [ev.id, result, pct, ev.defenders.size],
    );

    if (result === "defended" && ev.defenders.size > 0) {
      const until = new Date(Date.now() + EVENT_BONUS_DURATION_MS);
      await pool.query(`UPDATE sessions SET event_bonus_until = $2 WHERE id = ANY($1::bigint[])`, [
        [...ev.defenders],
        until,
      ]);
    }

    console.log(
      `[events] corruption event ${ev.id} resolved: ${result} (${(pct * 100).toFixed(1)}% corrupted, ${ev.defenders.size} defenders)`,
    );

    this.active = null;
    this.nextAt = Date.now() + env.eventIntervalMs;
    hub.broadcast({ t: "event", event: null });
  }
}

export const events = new EventEngine();
