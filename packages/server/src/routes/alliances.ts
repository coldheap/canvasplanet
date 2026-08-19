/**
 * Alliances / teams (ROADMAP.md §4.1) — named groups with a colour and their
 * own leaderboard beside countries. Membership mirrors country attribution
 * exactly: one alliance per session, decided by "last one you painted for"
 * (here: last one you explicitly joined), stored on `sessions.alliance_id`.
 *
 * The stats themselves live in alliances/store.ts, updated inside the paint
 * transaction (paint/service.ts) the same way country_stats is. This file is
 * only the CRUD/membership surface: list, create, join, leave, detail.
 */

import {
  ALLIANCE_CREATE_PER_DAY,
  ALLIANCE_JOIN_COOLDOWN_MS,
  ALLIANCE_NAME_MAX_LEN,
  ALLIANCE_NAME_MIN_LEN,
  isValidColor,
  type AllianceDTO,
} from "@canvasplanet/shared";
import type { FastifyInstance } from "fastify";
import { pool, tx } from "../db/pool.js";
import { alliances } from "../alliances/store.js";
import { getOrCreateSession } from "../session/session.js";

function normalizeName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== "string") return { error: "name must be a string" };
  const name = raw.trim();
  if (name.length < ALLIANCE_NAME_MIN_LEN || name.length > ALLIANCE_NAME_MAX_LEN) {
    return { error: `name must be ${ALLIANCE_NAME_MIN_LEN}-${ALLIANCE_NAME_MAX_LEN} characters` };
  }
  return { name };
}

/** alliances.id is a SMALLINT (SMALLSERIAL): anything outside this range is
 *  not just "not found", it is a Postgres numeric-overflow error (22003) if
 *  it reaches a query at all — so it is refused before ever building one. */
function parseAllianceId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 && id <= 32767 ? id : null;
}

export function registerAllianceRoutes(app: FastifyInstance): void {
  // ---- list: fresh names/colours alongside live stats ---------------------
  app.get("/api/alliances", async (_req, reply) => {
    const { rows } = await pool.query<AllianceDTO>(
      `SELECT id, name, color FROM alliances WHERE disabled_at IS NULL ORDER BY id`,
    );
    return reply.send({ alliances: rows, rows: alliances.rows() });
  });

  // ---- detail ---------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/alliances/:id", async (req, reply) => {
    const id = parseAllianceId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "id must be a valid alliance id" });

    const { rows } = await pool.query<{ id: number; name: string; color: number; created_at: Date }>(
      `SELECT id, name, color, created_at FROM alliances WHERE id = $1 AND disabled_at IS NULL`,
      [id],
    );
    const alliance = rows[0];
    if (!alliance) return reply.code(404).send();

    const stat = alliances.rows().find((r) => r[0] === id);
    const { rows: memberCount } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions WHERE alliance_id = $1`,
      [id],
    );

    return reply.send({
      ...alliance,
      cumulative: stat?.[1] ?? 0,
      held: stat?.[2] ?? 0,
      rank: alliances.rankOf(id),
      members: memberCount[0]?.n ?? 0,
    });
  });

  // ---- create ---------------------------------------------------------------
  app.post<{ Body: { name?: string; color?: number } }>("/api/alliances", async (req, reply) => {
    const session = await getOrCreateSession(req, reply);
    const body = req.body ?? {};

    const nameResult = normalizeName(body.name);
    if ("error" in nameResult) return reply.code(400).send({ error: nameResult.error });
    if (!isValidColor(body.color)) return reply.code(400).send({ error: "color must be a valid palette index" });

    const { rows: recent } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM alliances
        WHERE created_by = $1 AND created_at > now() - interval '1 day'`,
      [session.id],
    );
    if ((recent[0]?.n ?? 0) >= ALLIANCE_CREATE_PER_DAY) {
      return reply.code(429).send({ error: "too many alliances created from this session, try again tomorrow" });
    }

    let created: AllianceDTO;
    try {
      // One transaction: creating an alliance joins it (a two-step "create,
      // then separately join your own team" would be a confusing extra click
      // for no benefit), and a failure between the two writes must not leave
      // a name permanently taken by an alliance nobody — not even its own
      // creator — actually belongs to.
      created = await tx(async (c) => {
        const { rows } = await c.query<AllianceDTO>(
          `INSERT INTO alliances (name, color, created_by) VALUES ($1, $2, $3)
           RETURNING id, name, color`,
          [nameResult.name, body.color, session.id],
        );
        const row = rows[0]!;
        await c.query(
          `UPDATE sessions SET alliance_id = $2, alliance_changed_at = now() WHERE id = $1`,
          [session.id, row.id],
        );
        return row;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "that name is already taken" });
      }
      throw err;
    }

    await alliances.reload(created.id);
    return reply.send(created);
  });

  // ---- join / leave -----------------------------------------------------
  async function setAlliance(
    sessionId: number,
    targetId: number | null,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const { rows } = await pool.query<{ alliance_changed_at: Date | null }>(
      `SELECT alliance_changed_at FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const last = rows[0]?.alliance_changed_at;
    if (last && Date.now() - last.getTime() < ALLIANCE_JOIN_COOLDOWN_MS) {
      return {
        ok: false,
        status: 429,
        error: "you switched alliances too recently, try again in a few minutes",
      };
    }
    await pool.query(
      `UPDATE sessions SET alliance_id = $2, alliance_changed_at = now() WHERE id = $1`,
      [sessionId, targetId],
    );
    return { ok: true };
  }

  app.post<{ Params: { id: string } }>("/api/alliances/:id/join", async (req, reply) => {
    const session = await getOrCreateSession(req, reply);
    const id = parseAllianceId(req.params.id);
    if (id === null) return reply.code(404).send({ error: "no such alliance" });

    const { rows } = await pool.query(`SELECT 1 FROM alliances WHERE id = $1 AND disabled_at IS NULL`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "no such alliance" });

    const result = await setAlliance(session.id, id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.send({ ok: true, allianceId: id });
  });

  app.post("/api/alliances/leave", async (req, reply) => {
    const session = await getOrCreateSession(req, reply);
    const result = await setAlliance(session.id, null);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.send({ ok: true, allianceId: null });
  });
}
