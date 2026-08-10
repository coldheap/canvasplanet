/**
 * Country placement leaderboard state.
 *
 * Rows count placements by the painter's IP-derived country, not the
 * geographic country underneath the pixel. The two concepts intentionally
 * have separate tables: `country_stats` still powers map ownership/country
 * pages, while `country_placement_stats` powers this public leaderboard.
 */

import { type LbRow, type ServerMessage } from "@worldcanvas/shared";
import { pool } from "../db/pool.js";

export class LeaderboardStore {
  private stats = new Map<number, number>();
  private countryIdsByIso = new Map<string, number>();
  private world = 0;
  private dirty = false;

  async load(): Promise<void> {
    const [placements, totals, countries] = await Promise.all([
      pool.query<{ country_id: number; placements: number }>(
        `SELECT country_id, placements FROM country_placement_stats`,
      ),
      pool.query<{ world: number }>(
        `SELECT COALESCE(sum(cumulative), 0)::bigint AS world FROM country_stats`,
      ),
      pool.query<{ id: number; iso_a2: string }>(`SELECT id, iso_a2 FROM countries`),
    ]);
    this.stats.clear();
    this.countryIdsByIso.clear();
    for (const r of placements.rows) this.stats.set(r.country_id, r.placements);
    for (const r of countries.rows) this.countryIdsByIso.set(r.iso_a2.trim().toUpperCase(), r.id);
    this.world = totals.rows[0]?.world ?? 0;
    this.dirty = true;
    console.log(`[leaderboard] loaded ${this.stats.size} painter countries, ${this.world} paints`);
  }

  /** Mirrors a committed interactive paint. Null means its IP country could
   * not be resolved; it still contributes to the global paint total. */
  applyPlacement(countryId: number | null): void {
    if (countryId !== null) this.stats.set(countryId, (this.stats.get(countryId) ?? 0) + 1);
    this.world += 1;
    this.dirty = true;
  }

  /** Bot/admin bulk paths have no client IP but still advance the world total. */
  applySystemPaint(): void {
    this.world += 1;
    this.dirty = true;
  }

  countryIdForIso(iso: string | null): number | null {
    return iso === null ? null : (this.countryIdsByIso.get(iso.toUpperCase()) ?? null);
  }

  /** Full table, ranked. The third tuple value is retained for wire
   * compatibility; country-of-painter rankings are placements only. */
  rows(): LbRow[] {
    return [...this.stats.entries()]
      .filter(([, placements]) => placements > 0)
      .map(([id, placements]) => [id, placements, 0] as LbRow)
      .sort((a, b) => b[1] - a[1]);
  }

  worldTotal(): number {
    return this.world;
  }

  rankOf(countryId: number): number | null {
    const idx = this.rows().findIndex((r) => r[0] === countryId);
    return idx < 0 ? null : idx + 1;
  }

  /** Called on the 1 Hz hub tick. Returns null when nothing changed. */
  tick(): ServerMessage | null {
    if (!this.dirty) return null;
    this.dirty = false;
    return { t: "lb", world: this.world, rows: this.rows() };
  }
}

export const leaderboard = new LeaderboardStore();
