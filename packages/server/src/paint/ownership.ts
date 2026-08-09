import { alliances } from "../alliances/store.js";
import type { Client } from "../db/pool.js";
import { leaderboard } from "../leaderboard/store.js";
import { players } from "../players/store.js";

export interface PixelOwnership {
  countryId: number;
  allianceId: number | null;
  userId: number | null;
}

/** Move one currently-held pixel between owners without changing cumulative totals. */
export async function transferHeld(
  c: Client,
  previous: PixelOwnership | null,
  next: PixelOwnership | null,
): Promise<void> {
  if (previous?.countryId !== next?.countryId) {
    if (previous) {
      await c.query(`UPDATE country_stats SET held = GREATEST(0, held - 1) WHERE country_id = $1`, [
        previous.countryId,
      ]);
    }
    if (next) {
      await c.query(
        `INSERT INTO country_stats (country_id, cumulative, held) VALUES ($1, 0, 1)
         ON CONFLICT (country_id) DO UPDATE SET held = country_stats.held + 1`,
        [next.countryId],
      );
    }
  }

  if (previous?.allianceId !== next?.allianceId) {
    if (previous?.allianceId !== null && previous?.allianceId !== undefined) {
      await c.query(`UPDATE alliance_stats SET held = GREATEST(0, held - 1) WHERE alliance_id = $1`, [
        previous.allianceId,
      ]);
    }
    if (next?.allianceId !== null && next?.allianceId !== undefined) {
      await c.query(`UPDATE alliance_stats SET held = held + 1 WHERE alliance_id = $1`, [next.allianceId]);
    }
  }

  if (previous?.userId !== next?.userId) {
    if (previous?.userId !== null && previous?.userId !== undefined) {
      await c.query(`UPDATE user_stats SET held = GREATEST(0, held - 1) WHERE user_id = $1`, [previous.userId]);
    }
    if (next?.userId !== null && next?.userId !== undefined) {
      await c.query(`UPDATE user_stats SET held = held + 1 WHERE user_id = $1`, [next.userId]);
    }
  }
}

/** Record a staff/bot paint in cumulative counters; held is handled separately above. */
export async function incrementCumulative(c: Client, owner: PixelOwnership): Promise<void> {
  await c.query(
    `INSERT INTO country_stats (country_id, cumulative, held) VALUES ($1, 1, 0)
     ON CONFLICT (country_id) DO UPDATE SET cumulative = country_stats.cumulative + 1`,
    [owner.countryId],
  );
  if (owner.allianceId !== null) {
    await c.query(`UPDATE alliance_stats SET cumulative = cumulative + 1 WHERE alliance_id = $1`, [owner.allianceId]);
  }
  if (owner.userId !== null) {
    await c.query(`UPDATE user_stats SET cumulative = cumulative + 1 WHERE user_id = $1`, [owner.userId]);
  }
}

/** Bulk/admin writes bypass the stores' incremental path, so reconcile after commit. */
export async function reloadOwnershipStores(): Promise<void> {
  await Promise.all([leaderboard.load(), alliances.load(), players.load()]);
}
