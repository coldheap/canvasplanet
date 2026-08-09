/**
 * The corruption event engine (ROADMAP.md Phase 7) — a recurring vs-server
 * contest.
 *
 * On a fixed interval a bot session starts painting a random small zone a
 * fixed "corruption" colour at a steady tick. Any ordinary player paint
 * inside the zone with a different colour counts as defence — there is no
 * special pixel type, attribution works exactly like any other paint
 * (routes/paint.ts calls applyPaint() after every commit, same as the
 * leaderboard/alliance/player stores). When the timer ends the WHOLE zone is
 * reverted to its pre-event state, win or lose, via admin/revert.ts —
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
 * resolveEvent() has two race guards worth knowing about before touching it:
 * it awaits any bot write still in flight from the previous tick before
 * reverting (so the bot can't commit a pixel just after the revert already
 * ran), and it re-runs the revert a second time after a short delay, since
 * nothing gates ordinary /api/paint from landing in the zone in the brief
 * window around resolution — see resolveEvent()'s own comments.
 */

import { randomUUID } from "node:crypto";
import {
  bboxOverlaps,
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
} from "@worldcanvas/shared";
import { revert } from "../admin/revert.js";
import { pool, tx } from "../db/pool.js";
import { env } from "../env.js";
import { geo } from "../geo/index.js";
import { leaderboard } from "../leaderboard/store.js";
import { getProtectedRegions, isFrozen } from "../state/policy.js";
import { hub } from "../ws/hub.js";
import { ActiveEventState } from "./state.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EventEngine {
  private active: ActiveEventState | null = null;
  private nextAt = Date.now() + env.eventIntervalMs;
  private starting = false;
  private resolving = false;
  private botTicking = false;
  /** The in-flight botTick(), if any — resolveEvent() awaits this before
   *  reverting so the bot's own last writes can't land after the revert's
   *  SELECT already fixed its result set. See botTick()'s doc comment. */
  private botTickPromise: Promise<void> | null = null;

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
        { bbox: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }, since: r.started_at.getTime() },
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
          void this.resolveEvent(ev).finally(() => {
            this.resolving = false;
          });
        }
        return null;
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
      void this.startEvent(now).finally(() => {
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
      if (!regions.some((r) => bboxOverlaps(r, candidate))) return candidate;
    }
    return null;
  }

  private async startEvent(now: number): Promise<void> {
    // A frozen canvas means nobody can paint at all — starting a contest
    // defenders are structurally unable to respond to would not be a fair
    // fight. nextAt is left untouched, so this is retried every tick until
    // the freeze lifts, the same "just try again next tick" shape as a
    // failed zone pick just below.
    if (isFrozen()) return;

    const bbox = this.pickZone();
    if (!bbox) return; // try again next tick

    const endsAt = now + env.eventDurationMs;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO corruption_events (x0, y0, x1, y1, bot_color, started_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))
       RETURNING id`,
      [bbox.x0, bbox.y0, bbox.x1, bbox.y1, EVENT_BOT_COLOR, now, endsAt],
    );

    this.active = new ActiveEventState(rows[0]!.id, bbox, EVENT_BOT_COLOR, now, endsAt, randomUUID());
    console.log(
      `[events] corruption event ${this.active.id} started at (${bbox.x0},${bbox.y0})-(${bbox.x1},${bbox.y1}), ends in ${env.eventDurationMs}ms`,
    );
    hub.broadcast({ t: "event", event: this.active.toDTO() });
  }

  /**
   * The bot's brush stroke: EVENT_BOT_PIXELS_PER_TICK pixels per LB_TICK_MS,
   * same write shape as admin/stamp.ts (staff bypass — no charges, no
   * alliance/user attribution) but applied incrementally rather than as one
   * batch, since this runs continuously rather than once.
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
    for (let i = 0; i < EVENT_BOT_PIXELS_PER_TICK; i++) {
      const x = ev.bbox.x0 + Math.floor(Math.random() * EVENT_ZONE_SIZE);
      const y = ev.bbox.y0 + Math.floor(Math.random() * EVENT_ZONE_SIZE);
      const { countryId } = geo.lookup(x, y);

      const prevRow = await tx(async (c) => {
        const prev = await c.query<{ color: number; country_id: number }>(
          `SELECT color, country_id FROM pixels WHERE x = $1 AND y = $2 FOR UPDATE`,
          [x, y],
        );
        const prevRow = prev.rows[0] ?? null;

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
        await c.query(
          `INSERT INTO country_stats (country_id, cumulative, held)
           VALUES ($1, 1, CASE WHEN $2::boolean THEN 0 ELSE 1 END)
           ON CONFLICT (country_id) DO UPDATE
             SET cumulative = country_stats.cumulative + 1,
                 held = country_stats.held + CASE WHEN $2::boolean THEN 0 ELSE 1 END`,
          [countryId, prevRow?.country_id === countryId],
        );
        if (prevRow && prevRow.country_id !== countryId) {
          await c.query(
            `UPDATE country_stats SET held = GREATEST(0, held - 1) WHERE country_id = $1`,
            [prevRow.country_id],
          );
        }
        const chain = tileAncestry(x, y);
        await c.query(
          `INSERT INTO tile_dirty (z, x, y)
           SELECT * FROM UNNEST($1::smallint[], $2::int[], $3::int[])
           ON CONFLICT DO NOTHING`,
          [chain.map((t) => t.z), chain.map((t) => t.x), chain.map((t) => t.y)],
        );

        return prevRow;
      });

      hub.publishPaint(x, y, ev.botColor, countryId);
      leaderboard.applyPaint(countryId, prevRow?.country_id ?? null);
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
    if (this.botTickPromise) await this.botTickPromise;

    const pct = ev.corruptionPct();
    const result = ev.result();

    // Zero permanent trace either way — see migration 0014's header comment.
    await revert({ bbox: ev.bbox, since: ev.startedAt }, null);

    // The other half of the bug report — "pixels I placed myself weren't
    // rolled back": nothing stops an ordinary /api/paint request from
    // committing into the zone in the brief window between the SELECT above
    // and now (painting isn't gated on event state at all, by design — see
    // the module doc comment). A short-delayed second pass mops up whatever
    // landed in that window; revert() is idempotent, so on the common case
    // where nothing snuck in, this just finds zero affected rows.
    await sleep(REVERT_MOPUP_DELAY_MS);
    await revert({ bbox: ev.bbox, since: ev.startedAt }, null);

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
