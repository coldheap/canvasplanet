/**
 * The paint transaction — the spine of the whole application.
 *
 * Every rule that matters is enforced here, server-side, inside one database
 * transaction: bounds, protection, freeze, bans, terrain, cost, the charge
 * bank, the IP budget, both leaderboard counters, the history row, and the
 * tile dirty chain. A forged client cannot skip any of it.
 *
 * Ordering is deliberate: the cheap in-memory refusals run before any I/O,
 * and the two rows that can contend (`sessions`, `ip_budget`) are locked in a
 * fixed order so concurrent paints from the same session can never deadlock.
 */

import {
  CHARGE_MAX,
  effectiveRegenMs,
  IP_BUDGET_FLAGGED_ASN,
  IP_BUDGET_MAX,
  IP_BUDGET_REFILL_MS,
  PaintRefusal,
  type Terrain,
  findProtecting,
  inPaintBounds,
  isValidColor,
  msUntilNextCharge,
  paintCost,
  regenerate,
  spend,
  Z_PIXEL,
  tileIdOf,
} from "@worldcanvas/shared";
import type { Client } from "../db/pool.js";
import { tx } from "../db/pool.js";
import { geo } from "../geo/index.js";
import { isFlagged } from "../security/asn.js";
import { getProtectedRegions, isFrozen } from "../state/policy.js";

export interface PaintInput {
  sessionId: number;
  ip: string;
  /** Painter location inferred from the trusted client-IP country header. */
  originCountryId: number | null;
  x: number;
  y: number;
  color: number;
  /** Staff bypass charges and the IP budget, but are still audited. */
  staff: { id: number; role: "mod" | "admin" } | null;
}

export type PaintOutcome =
  | {
      ok: true;
      /** False when the requested colour already matches the pixel. */
      changed: boolean;
      cost: number;
      bank: number;
      nextAt: number | null;
      countryId: number;
      prevColor: number | null;
      prevCountryId: number | null;
      allianceId: number | null;
      prevAllianceId: number | null;
      userId: number | null;
      prevUserId: number | null;
    }
  | { ok: false; reason: PaintRefusal; retryAfterMs?: number; regionName?: string };

export async function paint(input: PaintInput): Promise<PaintOutcome> {
  const { x, y, color, sessionId, ip, originCountryId, staff } = input;

  // ---- Phase 1: refusals that need no I/O at all ------------------------
  if (!isValidColor(color)) return { ok: false, reason: PaintRefusal.BadColor };
  if (!inPaintBounds(x, y)) return { ok: false, reason: PaintRefusal.OutOfBounds };

  if (!staff) {
    if (isFrozen()) return { ok: false, reason: PaintRefusal.Frozen };
    const region = findProtecting(getProtectedRegions(), x, y);
    if (region) {
      return { ok: false, reason: PaintRefusal.Protected, regionName: region.name };
    }
  }

  // Land or water, and which country. In-memory: O(1) for ~98% of pixels,
  // one point-in-polygon for coastal and border tiles.
  const { countryId, terrain } = geo.lookup(x, y);

  return tx(async (c) => {
    const now = Date.now();

    // ---- Phase 2: lock the session, check the ban ------------------------
    // FOR UPDATE is what makes the charge bank safe against two concurrent
    // paints from the same session double-spending.
    const sess = await c.query<{
      charges: number;
      charges_updated_at: Date;
      banned_until: Date | null;
      asn: number | null;
      alliance_id: number | null;
      user_id: number | null;
      event_bonus_until: Date | null;
      explicitly_banned: boolean;
    }>(
      `SELECT s.charges, s.charges_updated_at, s.banned_until, s.asn,
              s.alliance_id, s.user_id, s.event_bonus_until,
              EXISTS (
                SELECT 1 FROM bans b
                 WHERE (b.session_id = s.id OR b.ip = $2::inet)
                   AND (b.until IS NULL OR b.until > now())
              ) AS explicitly_banned
         FROM sessions s WHERE s.id = $1 FOR UPDATE`,
      [sessionId, ip],
    );
    const s = sess.rows[0];
    if (!s) return { ok: false as const, reason: PaintRefusal.Banned };
    if (!staff && (s.explicitly_banned || (s.banned_until && s.banned_until.getTime() > now))) {
      return { ok: false as const, reason: PaintRefusal.Banned };
    }
    // Staff paint on behalf of no alliance or account — same reasoning as
    // their charges bypass: an admin stamp is not that admin's alliance or
    // account claiming territory.
    const allianceId = staff ? null : s.alliance_id;
    const userId = staff ? null : s.user_id;

    // ---- Phase 3: read the current pixel, decide the cost -----------------
    const cur = await c.query<{ color: number; country_id: number; alliance_id: number | null; user_id: number | null }>(
      `SELECT color, country_id, alliance_id, user_id FROM pixels WHERE x = $1 AND y = $2 FOR UPDATE`,
      [x, y],
    );
    const prev = cur.rows[0] ?? null;
    const prevColor = prev ? prev.color : null;
    const prevCountryId = prev ? prev.country_id : null;
    const prevAllianceId = prev ? prev.alliance_id : null;
    const prevUserId = prev ? prev.user_id : null;

    let bank = { charges: s.charges, updatedAt: s.charges_updated_at.getTime() };
    // The corruption event's reward (ROADMAP.md Phase 7) — a session that
    // defended a winning event regenerates faster until event_bonus_until.
    // Null for almost every session, so this is a no-op comparison for them.
    const regenMs = effectiveRegenMs(s.event_bonus_until?.getTime() ?? null, now);

    // Reapplying the colour that is already present cannot change the canvas.
    // Treat it as an idempotent success: no charge, history, counters, event
    // credit, dirty tile, or broadcast.
    if (prevColor === color) {
      if (!staff) bank = regenerate(bank, now, CHARGE_MAX, regenMs);
      return {
        ok: true as const,
        changed: false,
        cost: 0,
        bank: bank.charges,
        nextAt: nextChargeAt(bank, now, regenMs),
        countryId,
        prevColor,
        prevCountryId,
        allianceId,
        prevAllianceId,
        userId,
        prevUserId,
      };
    }

    const { cost } = paintCost({ currentColor: prevColor, newColor: color, terrain });

    // ---- Phase 4: spend, unless staff --------------------------------------

    if (!staff) {
      const spent = spend(bank, cost, now, CHARGE_MAX, regenMs);
      if (!spent) {
        const regenned = regenerate(bank, now, CHARGE_MAX, regenMs);
        return {
          ok: false as const,
          reason: PaintRefusal.NoCharges,
          retryAfterMs: msUntilNextCharge(regenned, now, CHARGE_MAX, regenMs) ?? 0,
        };
      }
      bank = spent;

      // The IP ceiling. Locked after the session row, always in that order.
      const budgetOk = await takeIpBudget(c, ip, cost, now, s.asn);
      if (!budgetOk.ok) {
        return {
          ok: false as const,
          reason: PaintRefusal.IpBudget,
          retryAfterMs: budgetOk.retryAfterMs,
        };
      }

    }

    // ---- Phase 5: write everything, in one round trip ---------------------
    //
    // Canvas, history, both leaderboard counters, the session row and the
    // tile dirty chain used to be six sequential statements. They are all
    // unconditional writes with no data dependency on each
    // other — everything they need was decided above — so they collapse into
    // one CTE. This also keeps bursts from a session's initial full bank from
    // turning into a chain of avoidable database round trips. Ordering inside
    // a CTE is not guaranteed, which is fine here
    // precisely because none of them reads what another writes.
    await c.query(
      `WITH px AS (
         INSERT INTO pixels (x, y, color, country_id, alliance_id, user_id, session_id, staff_id, painted_at)
         VALUES ($1, $2, $3, $4, $18, $21, $5, $6, now())
         ON CONFLICT (x, y) DO UPDATE
           SET color = EXCLUDED.color,
               country_id = EXCLUDED.country_id,
               alliance_id = EXCLUDED.alliance_id,
               user_id = EXCLUDED.user_id,
               session_id = EXCLUDED.session_id,
               staff_id = EXCLUDED.staff_id,
               painted_at = now(),
               paint_count = pixels.paint_count + 1
         RETURNING 1
       ),
       ev AS (
         INSERT INTO pixel_events
           (x, y, color, prev_color, country_id, alliance_id, user_id, session_id, staff_id, ip, cost)
         VALUES ($1, $2, $3, $7, $4, $18, $21, $5, $6, $8, $9)
         RETURNING 1
       ),
       gain AS (
         -- cumulative always climbs; held only moves on a change of owner.
         INSERT INTO country_stats (country_id, cumulative, held)
         VALUES ($4, 1, CASE WHEN $10::boolean THEN 0 ELSE 1 END)
         ON CONFLICT (country_id) DO UPDATE
           SET cumulative = country_stats.cumulative + 1,
               held = country_stats.held + CASE WHEN $10::boolean THEN 0 ELSE 1 END
         RETURNING 1
       ),
       loss AS (
         UPDATE country_stats SET held = GREATEST(0, held - 1)
          WHERE country_id = $11::smallint AND $11::smallint IS DISTINCT FROM $4::smallint
         RETURNING 1
       ),
       origin_gain AS (
         -- Unlike country_stats above, this attributes the placement to the
         -- painter's IP country rather than the pixel's map location.
         INSERT INTO country_placement_stats (country_id, placements)
         SELECT $24::smallint, 1
         WHERE $24::smallint IS NOT NULL
         ON CONFLICT (country_id) DO UPDATE
           SET placements = country_placement_stats.placements + 1
         RETURNING 1
       ),
       gain_alliance AS (
         -- Same shape as gain/loss, but only when the painting session
         -- belongs to an alliance at all — most sessions never touch this.
         INSERT INTO alliance_stats (alliance_id, cumulative, held)
         SELECT $18::smallint, 1, CASE WHEN $19::boolean THEN 0 ELSE 1 END
         WHERE $18::smallint IS NOT NULL
         ON CONFLICT (alliance_id) DO UPDATE
           SET cumulative = alliance_stats.cumulative + 1,
               held = alliance_stats.held + CASE WHEN $19::boolean THEN 0 ELSE 1 END
         RETURNING 1
       ),
       loss_alliance AS (
         UPDATE alliance_stats SET held = GREATEST(0, held - 1)
          WHERE alliance_id = $20::smallint AND $20::smallint IS DISTINCT FROM $18::smallint
         RETURNING 1
       ),
       gain_user AS (
         -- Same shape again, one level down: only when the painting session
         -- is attached to an account — most sessions never touch this either.
         --
         -- Streaks (ROADMAP.md Phase 6) ride along here rather than as a
         -- separate CTE: they need the same "only when user_id IS NOT NULL"
         -- guard and the same old-row-vs-new-row comparison the INSERT ...
         -- ON CONFLICT already does, so EXCLUDED.last_paint_date (today, UTC)
         -- against user_stats.last_paint_date (the pre-update value) is all a
         -- streak transition needs: same day -> unchanged, exactly one day
         -- earlier -> +1, anything else (including a first-ever paint) -> 1.
         INSERT INTO user_stats (user_id, cumulative, held, last_paint_date, streak_days, best_streak)
         SELECT $21::bigint, 1, CASE WHEN $22::boolean THEN 0 ELSE 1 END,
                (now() AT TIME ZONE 'utc')::date, 1, 1
         WHERE $21::bigint IS NOT NULL
         ON CONFLICT (user_id) DO UPDATE
           SET cumulative = user_stats.cumulative + 1,
               held = user_stats.held + CASE WHEN $22::boolean THEN 0 ELSE 1 END,
               streak_days = CASE
                 WHEN user_stats.last_paint_date = EXCLUDED.last_paint_date THEN user_stats.streak_days
                 WHEN user_stats.last_paint_date = EXCLUDED.last_paint_date - 1 THEN user_stats.streak_days + 1
                 ELSE 1
               END,
               best_streak = GREATEST(user_stats.best_streak, CASE
                 WHEN user_stats.last_paint_date = EXCLUDED.last_paint_date THEN user_stats.streak_days
                 WHEN user_stats.last_paint_date = EXCLUDED.last_paint_date - 1 THEN user_stats.streak_days + 1
                 ELSE 1
               END),
               last_paint_date = EXCLUDED.last_paint_date
         RETURNING 1
       ),
       loss_user AS (
         UPDATE user_stats SET held = GREATEST(0, held - 1)
          WHERE user_id = $23::bigint AND $23::bigint IS DISTINCT FROM $21::bigint
         RETURNING 1
       ),
       sess AS (
         UPDATE sessions
            SET last_seen_at = now(),
                -- Staff bypass the bank, so only the timestamp moves for them.
                charges = CASE WHEN $12::boolean THEN charges ELSE $13::smallint END,
                charges_updated_at = CASE WHEN $12::boolean THEN charges_updated_at
                                          ELSE to_timestamp($14 / 1000.0) END,
                last_country_id = CASE WHEN $12::boolean THEN last_country_id ELSE $4::smallint END,
                total_paints = total_paints + CASE WHEN $12::boolean THEN 0 ELSE 1 END
          WHERE id = $5
         RETURNING 1
       ),
       dirty AS (
         -- ONE row, not the whole Z_PIXEL+1-deep ancestry.
         --
         -- Writing the full chain here meant Z_PIXEL+1 index insertions and their
         -- WAL on every paint, on the request path, to record something the
         -- worker can derive for itself. The worker now marks a tile's parent
         -- when it renders it, so the chain still propagates — but it is
         -- deduplicated across every paint that shared a tile instead of
         -- being rewritten by each one.
         INSERT INTO tile_dirty (z, x, y) VALUES ($15, $16, $17)
         ON CONFLICT (z, x, y) DO NOTHING
         RETURNING 1
       )
       SELECT 1`,
      [
        x,
        y,
        color,
        countryId,
        sessionId,
        staff?.id ?? null,
        prevColor,
        ip,
        cost,
        prevCountryId === countryId,
        prevCountryId,
        staff !== null,
        bank.charges,
        bank.updatedAt,
        Z_PIXEL,
        x >> 8,
        y >> 8,
        allianceId,
        prevAllianceId === allianceId,
        prevAllianceId,
        userId,
        prevUserId === userId,
        prevUserId,
        originCountryId,
      ],
    );

    return {
      ok: true as const,
      changed: true,
      cost,
      bank: bank.charges,
      nextAt: nextChargeAt(bank, now, regenMs),
      countryId,
      prevColor,
      prevCountryId,
      allianceId,
      prevAllianceId,
      userId,
      prevUserId,
    };
  });
}

function nextChargeAt(bank: { charges: number; updatedAt: number }, now: number, regenMs: number): number | null {
  const ms = msUntilNextCharge(bank, now, CHARGE_MAX, regenMs);
  return ms === null ? null : now + ms;
}

/**
 * IP-wide token bucket. Refilled lazily with the same arithmetic as the
 * charge bank, so a single honest user (regenerating 120 charges/hour)
 * exactly matches the 120/hour ceiling and never trips it — while a
 * cookie-wipe farm sharing one IP is capped within minutes.
 */
async function takeIpBudget(
  c: Client,
  ip: string,
  cost: number,
  now: number,
  asn: number | null,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  // Decided from the session's stored ASN against the in-memory flagged set.
  // The previous version read ip_budget.flagged_asn, which is both an extra
  // round trip and wrong on the first paint from an address — the row it
  // reads is created by the upsert immediately below, so the first request
  // from a datacenter IP got the full budget. The column is now purely
  // informational, for the admin dashboard.
  const max = asn !== null && isFlagged(asn) ? IP_BUDGET_FLAGGED_ASN : IP_BUDGET_MAX;

  // Refill, check and deduct in a single statement. Previously this was an
  // upsert to read the row, the arithmetic in JS, then an update to write it
  // back — two round trips, and a read-modify-write that only held together
  // because the surrounding transaction serialised it.
  //
  // Doing the arithmetic in SQL keeps it to one round trip and makes the
  // deduction atomic on its own terms. The ON CONFLICT ... WHERE clause is
  // what refuses: if the bucket cannot cover the cost, no row is updated and
  // nothing is returned.
  const { rows } = await c.query<{ tokens: number; refused: boolean; retry_ms: number | null }>(
    `INSERT INTO ip_budget AS b (ip, tokens, updated_at)
     VALUES ($1, $2::real - $3::real, now())
     ON CONFLICT (ip) DO UPDATE
       SET tokens = LEAST($2::real,
                          b.tokens + EXTRACT(EPOCH FROM (now() - b.updated_at)) * 1000.0 / $4::real
                    ) - $3::real,
           updated_at = now()
       WHERE (b.blocked_until IS NULL OR b.blocked_until <= now())
         AND LEAST($2::real,
                   b.tokens + EXTRACT(EPOCH FROM (now() - b.updated_at)) * 1000.0 / $4::real
             ) >= $3::real
     RETURNING tokens, false AS refused, NULL::int AS retry_ms`,
    [ip, max, cost, IP_BUDGET_REFILL_MS],
  );

  if (rows.length > 0) return { ok: true };

  // Refused. Read the row once more to say *how long* — worth the extra trip
  // on the rejection path, which by definition is not the hot one.
  const { rows: state } = await c.query<{ tokens: number; updated_at: Date; blocked_until: Date | null }>(
    `SELECT tokens, updated_at, blocked_until FROM ip_budget WHERE ip = $1`,
    [ip],
  );
  const row = state[0];
  if (row?.blocked_until && row.blocked_until.getTime() > now) {
    return { ok: false, retryAfterMs: row.blocked_until.getTime() - now };
  }
  const available = row
    ? Math.min(max, row.tokens + (now - row.updated_at.getTime()) / IP_BUDGET_REFILL_MS)
    : max;
  return {
    ok: false,
    retryAfterMs: Math.max(1, Math.ceil((cost - available) * IP_BUDGET_REFILL_MS)),
  };
}

export type { Terrain };
