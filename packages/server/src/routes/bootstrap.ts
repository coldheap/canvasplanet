import {
  CHARGE_MAX,
  CHARGE_REGEN_MS,
  type BootstrapResponse,
  msUntilNextCharge,
  regenerate,
} from "@worldcanvas/shared";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { leaderboard } from "../leaderboard/store.js";
import { alliances } from "../alliances/store.js";
import { players } from "../players/store.js";
import { env } from "../env.js";
import * as turnstile from "../security/turnstile.js";
import { getOrCreateSession } from "../session/session.js";
import { getProtectedRegions, isFrozen } from "../state/policy.js";
import { getAuthUser, getUserDTO } from "./auth.js";
import { getStaff } from "./staff.js";

/**
 * One round trip from cold load to a usable app. Everything the client needs
 * before it can render a frame lives here — deliberately, because a chain of
 * dependent requests is what makes a map app feel slow on a phone.
 */
export function registerBootstrapRoutes(app: FastifyInstance): void {
  app.get("/api/bootstrap", async (req, reply) => {
    const session = await getOrCreateSession(req, reply);
    const staff = await getStaff(req);
    const authUser = await getAuthUser(req);
    const now = Date.now();

    // Regenerate for display only; the authoritative spend happens in the
    // paint transaction. This is a read, so it does not persist.
    const bank = regenerate(
      { charges: session.charges, updatedAt: session.chargesUpdatedAt },
      now,
      CHARGE_MAX,
    );
    const nextMs = msUntilNextCharge(bank, now, CHARGE_MAX);

    const { rows: countries } = await pool.query(
      `SELECT id, iso_a2, name, flag FROM countries ORDER BY id`,
    );
    const { rows: allianceRows } = await pool.query(
      `SELECT id, name, color FROM alliances WHERE disabled_at IS NULL ORDER BY id`,
    );

    const body: BootstrapResponse = {
      bank: bank.charges,
      max: CHARGE_MAX,
      nextAt: nextMs === null ? null : now + nextMs,
      regenMs: CHARGE_REGEN_MS,
      yourCountryId: session.lastCountryId,
      verified: session.turnstileOk || !turnstile.isEnabled(),
      staff: staff ? { id: staff.id, username: staff.username, role: staff.role } : null,
      user: authUser ? await getUserDTO(authUser.id, authUser.email, authUser.displayName) : null,
      countries,
      leaderboard: leaderboard.rows(),
      world: leaderboard.worldTotal(),
      yourAllianceId: session.allianceId,
      alliances: allianceRows,
      allianceLeaderboard: alliances.rows(),
      playerLeaderboard: players.rows(),
      regions: getProtectedRegions().map((r) => ({
        id: r.id,
        name: r.name,
        x0: r.x0,
        y0: r.y0,
        x1: r.x1,
        y1: r.y1,
      })),
      frozen: isFrozen(),
      turnstileSitekey: turnstile.sitekey(),
      discordEnabled: env.discord.enabled,
    };
    return reply.send(body);
  });

  app.get("/api/health", async () => ({ ok: true }));
}
