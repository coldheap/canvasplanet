/**
 * Leaderboard state.
 *
 * `country_stats` is denormalised and updated inside the paint transaction,
 * so this never aggregates on read. It holds the full ~200-row table in
 * memory, applies increments as paints land, and emits a delta frame once a
 * second — the climbing number is the whole point of the app, so it is the
 * one thing every client receives regardless of viewport.
 */

import { type LbRow, type ServerMessage } from "@worldcanvas/shared";
import { pool } from "../db/pool.js";

interface Stat {
  cumulative: number;
  held: number;
}

class LeaderboardStore {
  private stats = new Map<number, Stat>();
  private world = 0;
  private dirty = false;

  async load(): Promise<void> {
    const { rows } = await pool.query<{ country_id: number; cumulative: number; held: number }>(
      `SELECT country_id, cumulative, held FROM country_stats`,
    );
    this.stats.clear();
    this.world = 0;
    for (const r of rows) {
      this.stats.set(r.country_id, { cumulative: r.cumulative, held: r.held });
      this.world += r.cumulative;
    }
    this.dirty = true;
    console.log(`[leaderboard] loaded ${this.stats.size} countries, ${this.world} paints`);
  }

  /** Mirrors exactly what the paint transaction did to country_stats. */
  applyPaint(countryId: number, prevCountryId: number | null): void {
    const s = this.stats.get(countryId) ?? { cumulative: 0, held: 0 };
    s.cumulative += 1;
    if (prevCountryId !== countryId) s.held += 1;
    this.stats.set(countryId, s);

    if (prevCountryId !== null && prevCountryId !== countryId) {
      const p = this.stats.get(prevCountryId);
      if (p) p.held = Math.max(0, p.held - 1);
    }

    this.world += 1;
    this.dirty = true;
  }

  /** Full table, ranked. Ranking is by cumulative; `held` rides along so the
   *  panel's toggle needs no second request. */
  rows(): LbRow[] {
    return [...this.stats.entries()]
      .map(([id, s]) => [id, s.cumulative, s.held] as LbRow)
      .sort((a, b) => b[1] - a[1]);
  }

  worldTotal(): number {
    return this.world;
  }

  rankOf(countryId: number): number | null {
    const idx = this.rows().findIndex((r) => r[0] === countryId);
    return idx < 0 ? null : idx + 1;
  }

  /** Called on the 1 Hz hub tick. Returns null when nothing changed, so a
   *  quiet canvas costs no bandwidth at all. */
  tick(): ServerMessage | null {
    if (!this.dirty) return null;
    this.dirty = false;
    return { t: "lb", world: this.world, rows: this.rows() };
  }
}

export const leaderboard = new LeaderboardStore();
