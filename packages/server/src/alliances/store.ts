/**
 * Alliance leaderboard state — mirrors leaderboard/store.ts exactly, one
 * level down: `alliance_stats` is denormalised and updated inside the paint
 * transaction (see paint/service.ts), so this never aggregates on read.
 *
 * The one real difference from the country store: an alliance is optional.
 * Most sessions have `alliance_id IS NULL` and never touch this at all,
 * where every session always has *some* country.
 */

import { type AllianceLbRow, type ServerMessage } from "@worldcanvas/shared";
import { pool } from "../db/pool.js";

interface Stat {
  cumulative: number;
  held: number;
}

export class AllianceStore {
  private stats = new Map<number, Stat>();
  private dirty = false;

  async load(): Promise<void> {
    const { rows } = await pool.query<{ alliance_id: number; cumulative: number; held: number }>(
      `SELECT alliance_id, cumulative, held FROM alliance_stats`,
    );
    this.stats.clear();
    for (const r of rows) {
      this.stats.set(r.alliance_id, { cumulative: r.cumulative, held: r.held });
    }
    this.dirty = true;
    console.log(`[alliances] loaded ${this.stats.size} alliances with stats`);
  }

  /** Mirrors exactly what the paint transaction did to alliance_stats. A
   *  session with no alliance passes null for both and this is a no-op. */
  applyPaint(allianceId: number | null, prevAllianceId: number | null): void {
    if (allianceId !== null) {
      const s = this.stats.get(allianceId) ?? { cumulative: 0, held: 0 };
      s.cumulative += 1;
      if (prevAllianceId !== allianceId) s.held += 1;
      this.stats.set(allianceId, s);
      this.dirty = true;
    }

    if (prevAllianceId !== null && prevAllianceId !== allianceId) {
      const p = this.stats.get(prevAllianceId);
      if (p) {
        p.held = Math.max(0, p.held - 1);
        this.dirty = true;
      }
    }
  }

  /**
   * (Re)loads one alliance's row from `alliance_stats`, defaulting to zero
   * if it has none yet. Two callers:
   *   - a brand-new alliance, so it appears in rows() before its first paint
   *     rather than looking like creation silently failed;
   *   - admin re-enabling a previously disabled one, so it comes back with
   *     its real historical numbers rather than resetting to zero.
   */
  async reload(allianceId: number): Promise<void> {
    const { rows } = await pool.query<{ cumulative: number; held: number }>(
      `SELECT cumulative, held FROM alliance_stats WHERE alliance_id = $1`,
      [allianceId],
    );
    const r = rows[0];
    this.stats.set(allianceId, r ? { cumulative: r.cumulative, held: r.held } : { cumulative: 0, held: 0 });
    this.dirty = true;
  }

  /** Admin-disable: drop it from the live leaderboard immediately rather
   *  than waiting for the next full load() (which only happens on boot). */
  remove(allianceId: number): void {
    if (this.stats.delete(allianceId)) this.dirty = true;
  }

  rows(): AllianceLbRow[] {
    return [...this.stats.entries()]
      .map(([id, s]) => [id, s.cumulative, s.held] as AllianceLbRow)
      .sort((a, b) => b[1] - a[1]);
  }

  rankOf(allianceId: number): number | null {
    const idx = this.rows().findIndex((r) => r[0] === allianceId);
    return idx < 0 ? null : idx + 1;
  }

  /** Called on the 1 Hz hub tick, same cadence as the country leaderboard. */
  tick(): ServerMessage | null {
    if (!this.dirty) return null;
    this.dirty = false;
    return { t: "alb", rows: this.rows() };
  }
}

export const alliances = new AllianceStore();
