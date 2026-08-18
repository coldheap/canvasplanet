/**
 * Player leaderboard state (ROADMAP.md §5.2) — mirrors leaderboard/store.ts
 * and alliances/store.ts exactly, one level down again: `user_stats` is
 * denormalised and updated inside the paint transaction (see
 * paint/service.ts), so this never aggregates on read.
 *
 * Like alliance membership, having an account is optional — most sessions
 * have `user_id IS NULL` and never touch this at all.
 */

import { type UserLbRow, type ServerMessage } from "@worldcanvas/shared";
import { pool } from "../db/pool.js";

interface Stat {
  displayName: string;
  avatarRevision: string | null;
  cumulative: number;
  held: number;
  /** UTC date string ("YYYY-MM-DD") of this player's last paint, or null if
   *  never painted — mirrors user_stats.last_paint_date, see paint/service.ts. */
  lastPaintDate: string | null;
  /** Current consecutive-day streak (ROADMAP.md Phase 6). Best-streak is not
   *  tracked here — it's never broadcast on the leaderboard, only read
   *  straight from the DB for the account panel (routes/auth.ts's
   *  getUserDTO), so mirroring it in memory here would be dead arithmetic. */
  streakDays: number;
}

/** UTC calendar date, "YYYY-MM-DD" — matches the paint transaction's
 *  `(now() AT TIME ZONE 'utc')::date`. */
function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isNextUtcDay(prev: string, next: string): boolean {
  const prevMs = Date.parse(`${prev}T00:00:00Z`);
  const nextMs = Date.parse(`${next}T00:00:00Z`);
  return nextMs - prevMs === 24 * 60 * 60 * 1000;
}

export class PlayerStore {
  private stats = new Map<number, Stat>();
  private dirty = false;

  async load(): Promise<void> {
    // last_paint_date comes back as text, not node-postgres's default parsed
    // Date — that constructor builds a Date at *local* midnight, and on a
    // server whose local timezone isn't UTC, round-tripping it through
    // toISOString() silently shifts it onto the wrong calendar day. Every
    // other date computation here (the SQL CTE, applyPaint's Date.now())
    // treats the day as a plain string for exactly this reason; to_char
    // keeps this read consistent with them instead of reintroducing a Date.
    const { rows } = await pool.query<{
      user_id: number;
      display_name: string;
      avatar_revision: string | null;
      cumulative: number;
      held: number;
      last_paint_date: string | null;
      streak_days: number;
    }>(
      `SELECT us.user_id, u.display_name, a.revision::text AS avatar_revision, us.cumulative, us.held,
              to_char(us.last_paint_date, 'YYYY-MM-DD') AS last_paint_date, us.streak_days
         FROM user_stats us
         JOIN users u ON u.id = us.user_id
         LEFT JOIN user_avatars a ON a.user_id = u.id`,
    );
    this.stats.clear();
    for (const r of rows) {
      this.stats.set(r.user_id, {
        displayName: r.display_name,
        avatarRevision: r.avatar_revision,
        cumulative: r.cumulative,
        held: r.held,
        lastPaintDate: r.last_paint_date,
        streakDays: r.streak_days,
      });
    }
    this.dirty = true;
    console.log(`[players] loaded ${this.stats.size} players with stats`);
  }

  /**
   * Seeds the display-name cache for a brand-new account, called right after
   * signup. Not strictly required — the next full load() would pick it up —
   * but without it a player who signs up and paints before the next restart
   * would render with a blank name, since applyPaint() below has no name to
   * fall back on. No stats row needed: a fresh account starts at zero either
   * way (ROADMAP.md §5.1 — signup is a fresh start), so this does not mark
   * the store dirty; nothing rank-worthy has changed yet.
   */
  register(userId: number, displayName: string, avatarRevision: string | null = null): void {
    if (!this.stats.has(userId)) {
      this.stats.set(userId, { displayName, avatarRevision, cumulative: 0, held: 0, lastPaintDate: null, streakDays: 0 });
    }
  }

  /** Changes appearance without touching ranking arithmetic. Marking dirty
   *  pushes the new revision to every open leaderboard on the next hub tick. */
  setAvatar(userId: number, avatarRevision: string | null): void {
    const s = this.stats.get(userId);
    if (!s || s.avatarRevision === avatarRevision) return;
    s.avatarRevision = avatarRevision;
    this.dirty = true;
  }

  /** Mirrors exactly what the paint transaction did to user_stats. A session
   *  with no linked account passes null for both and this is a no-op.
   *  `now` is injectable for testing the day-boundary streak logic without
   *  depending on the real clock; every real call site uses the default. */
  applyPaint(userId: number | null, prevUserId: number | null, now: number = Date.now()): void {
    if (userId !== null) {
      const s = this.stats.get(userId) ?? {
        displayName: "",
        avatarRevision: null,
        cumulative: 0,
        held: 0,
        lastPaintDate: null,
        streakDays: 0,
      };
      s.cumulative += 1;
      if (prevUserId !== userId) s.held += 1;

      const today = utcDateString(now);
      if (s.lastPaintDate !== today) {
        s.streakDays = s.lastPaintDate !== null && isNextUtcDay(s.lastPaintDate, today) ? s.streakDays + 1 : 1;
        s.lastPaintDate = today;
      }

      this.stats.set(userId, s);
      this.dirty = true;
    }

    if (prevUserId !== null && prevUserId !== userId) {
      const p = this.stats.get(prevUserId);
      if (p) {
        p.held = Math.max(0, p.held - 1);
        this.dirty = true;
      }
    }
  }

  /**
   * Drops a player from the leaderboard mirror entirely — account deletion
   * (routes/auth.ts's DELETE /api/auth/me), which has just zeroed the same
   * row in `user_stats` and detached the pixels behind it.
   *
   * Deleting the entry rather than zeroing it in place matters: a zeroed
   * entry survives here holding the pre-deletion display name, and the very
   * next paint that overpaints one of their old pixels would resurrect it
   * into `rows()` under that name (applyPaint reuses an existing entry when
   * it finds one).
   */
  forget(userId: number): void {
    if (this.stats.delete(userId)) this.dirty = true;
  }

  /** Ranked, and only players who have actually painted under their account
   *  — an account that only ever signed up has nothing to rank. */
  rows(): UserLbRow[] {
    return [...this.stats.entries()]
      .filter(([, s]) => s.cumulative > 0)
      .map(([id, s]) => [id, s.displayName, s.cumulative, s.held, s.streakDays, s.avatarRevision] as UserLbRow)
      .sort((a, b) => b[2] - a[2]);
  }

  rankOf(userId: number): number | null {
    const idx = this.rows().findIndex((r) => r[0] === userId);
    return idx < 0 ? null : idx + 1;
  }

  /** Called on the 1 Hz hub tick, same cadence as the other leaderboards. */
  tick(): ServerMessage | null {
    if (!this.dirty) return null;
    this.dirty = false;
    return { t: "plb", rows: this.rows() };
  }
}

export const players = new PlayerStore();
