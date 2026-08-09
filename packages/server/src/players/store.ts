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
  cumulative: number;
  held: number;
}

export class PlayerStore {
  private stats = new Map<number, Stat>();
  private dirty = false;

  async load(): Promise<void> {
    const { rows } = await pool.query<{
      user_id: number;
      display_name: string;
      cumulative: number;
      held: number;
    }>(
      `SELECT us.user_id, u.display_name, us.cumulative, us.held
         FROM user_stats us JOIN users u ON u.id = us.user_id`,
    );
    this.stats.clear();
    for (const r of rows) {
      this.stats.set(r.user_id, { displayName: r.display_name, cumulative: r.cumulative, held: r.held });
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
  register(userId: number, displayName: string): void {
    if (!this.stats.has(userId)) {
      this.stats.set(userId, { displayName, cumulative: 0, held: 0 });
    }
  }

  /** Mirrors exactly what the paint transaction did to user_stats. A session
   *  with no linked account passes null for both and this is a no-op. */
  applyPaint(userId: number | null, prevUserId: number | null): void {
    if (userId !== null) {
      const s = this.stats.get(userId) ?? { displayName: "", cumulative: 0, held: 0 };
      s.cumulative += 1;
      if (prevUserId !== userId) s.held += 1;
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

  /** Ranked, and only players who have actually painted under their account
   *  — an account that only ever signed up has nothing to rank. */
  rows(): UserLbRow[] {
    return [...this.stats.entries()]
      .filter(([, s]) => s.cumulative > 0)
      .map(([id, s]) => [id, s.displayName, s.cumulative, s.held] as UserLbRow)
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
