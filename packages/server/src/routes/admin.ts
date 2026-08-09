/**
 * The in-app admin API.
 *
 * Everything the admin panel does goes through here. Two roles:
 *   mod   — cleanup: inspect, revert, ban, stats
 *   admin — the above plus regions, freeze, image stamp, staff, audit log
 *
 * Every mutating route writes to `audit_log`. "Who froze the canvas?" must
 * always have an answer.
 */

import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { pool, tx } from "../db/pool.js";
import { renderReportThumbnail, reportSuspects } from "../admin/reports.js";
import { revert, type RevertSelector } from "../admin/revert.js";
import { stamp, type StampInput } from "../admin/stamp.js";
import { events } from "../events/engine.js";
import { geo } from "../geo/index.js";
import { eventLoopLag, resetEventLoopLag, tileEncodeTime, tileQueryTime } from "../metrics.js";
import { leaderboard } from "../leaderboard/store.js";
import { alliances } from "../alliances/store.js";
import * as scoring from "../security/score.js";
import { cacheStats } from "../tiles/cache.js";
import { queueDepth, workerStats } from "../tiles/worker.js";
import { reloadRegions, setFrozen } from "../state/policy.js";
import { hub } from "../ws/hub.js";
import { requireRole } from "./staff.js";

export function registerAdminRoutes(app: FastifyInstance): void {
  const mod = requireRole("mod");
  const admin = requireRole("admin");

  // ---- live dashboard ----------------------------------------------------
  app.get("/api/admin/stats", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    const [{ rows: pps }, depth] = await Promise.all([
      pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pixel_events WHERE created_at > now() - interval '10 seconds'`,
      ),
      queueDepth(),
    ]);
    const { rows: topIps } = await pool.query(
      `SELECT ip::text, count(*)::int AS paints
         FROM pixel_events
        WHERE created_at > now() - interval '1 hour'
        GROUP BY ip ORDER BY paints DESC LIMIT 10`,
    );
    return reply.send({
      pps: Math.round((pps[0]?.n ?? 0) / 10),
      world: leaderboard.worldTotal(),
      ws: hub.stats(),
      // Event-loop lag is the metric that distinguishes "the database is
      // slow" from "something on this thread is blocking every request".
      // Without it those look identical from the outside. Reset after
      // reading so each dashboard poll reflects the window since the last
      // one, not an ever-growing average since process start.
      loop: (() => {
        const stats = eventLoopLag();
        resetEventLoopLag();
        return stats;
      })(),
      tileTiming: { query: tileQueryTime.stats(), encode: tileEncodeTime.stats() },
      tiles: { queue: depth, ...cacheStats(), ...workerStats() },
      geo: geo.stats(),
      scoring: scoring.stats(),
      topIps,
    });
  });

  // ---- forensics: who painted this pixel -----------------------------------
  app.get<{ Params: { x: string; y: string } }>(
    "/api/admin/inspect/:x/:y",
    async (req, reply) => {
      if (!(await mod(req, reply))) return;
      const { rows } = await pool.query(
        `SELECT e.*, s.ip::text AS session_ip, s.total_paints, s.created_at AS session_created
           FROM pixel_events e
           LEFT JOIN sessions s ON s.id = e.session_id
          WHERE e.x = $1 AND e.y = $2
          ORDER BY e.id DESC LIMIT 20`,
        [Number(req.params.x), Number(req.params.y)],
      );
      return reply.send({ history: rows });
    },
  );

  // ---- revert -------------------------------------------------------------
  app.post<{ Body: RevertSelector }>("/api/admin/revert", async (req, reply) => {
    const staff = await mod(req, reply);
    if (!staff) return;
    // Mods are capped at an hour of history; a wider blast radius is an
    // admin action. See PLAN.md §7.
    if (staff.role === "mod" && req.body.since && Date.now() - req.body.since > 3600_000) {
      return reply.code(403).send({ error: "Mods can revert at most one hour of history." });
    }
    return reply.send(await revert(req.body, staff.id));
  });

  // ---- bans ---------------------------------------------------------------
  app.post<{ Body: { ip?: string; sessionId?: number; hours?: number; reason?: string } }>(
    "/api/admin/ban",
    async (req, reply) => {
      const staff = await mod(req, reply);
      if (!staff) return;
      const { ip, sessionId, hours, reason } = req.body;
      if (!ip && sessionId === undefined) {
        return reply.code(400).send({ error: "ip or sessionId is required" });
      }
      if (ip && isIP(ip) === 0) return reply.code(400).send({ error: "ip must be a valid IPv4 or IPv6 address" });
      if (sessionId !== undefined && (!Number.isInteger(sessionId) || sessionId < 1)) {
        return reply.code(400).send({ error: "sessionId must be a positive integer" });
      }
      if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) {
        return reply.code(400).send({ error: "hours must be a positive number" });
      }
      const until = hours === undefined ? null : new Date(Date.now() + hours * 3600_000);

      await tx(async (c) => {
        await c.query(
          `INSERT INTO bans (ip, session_id, until, reason, staff_id) VALUES ($1,$2,$3,$4,$5)`,
          [ip ?? null, sessionId ?? null, until, reason ?? null, staff.id],
        );
        if (sessionId !== undefined) {
          await c.query(`UPDATE sessions SET banned_until = $2 WHERE id = $1`, [sessionId, until]);
        }
        if (ip) {
          await c.query(
            `INSERT INTO ip_budget (ip, blocked_until) VALUES ($1, $2)
             ON CONFLICT (ip) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`,
            [ip, until],
          );
          // Ban every session behind that IP, not just the one that was caught.
          await c.query(`UPDATE sessions SET banned_until = $2 WHERE ip = $1`, [ip, until]);
        }
      });
      if (sessionId !== undefined) scoring.forget(sessionId);
      await audit(staff.id, "ban", req.body, null);
      return reply.send({ ok: true, until });
    },
  );

  // ---- protected regions (admin only) -------------------------------------
  app.get("/api/admin/regions", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const { rows } = await pool.query(`SELECT * FROM protected_regions ORDER BY id`);
    return reply.send(rows);
  });

  app.post<{ Body: { name: string; x0: number; y0: number; x1: number; y1: number } }>(
    "/api/admin/regions",
    async (req, reply) => {
      const staff = await admin(req, reply);
      if (!staff) return;
      const { name, x0, y0, x1, y1 } = req.body;
      const { rows } = await pool.query(
        `INSERT INTO protected_regions (name, x0, y0, x1, y1, created_by)
         VALUES ($1, LEAST($2,$4), LEAST($3,$5), GREATEST($2,$4), GREATEST($3,$5), $6)
         RETURNING *`,
        [name, x0, y0, x1, y1, staff.id],
      );
      await reloadRegions();
      const region = rows[0];
      hub.broadcast({ t: "region", op: "add", region });
      await audit(staff.id, "region.add", req.body, null);
      return reply.send(region);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/regions/:id", async (req, reply) => {
    const staff = await admin(req, reply);
    if (!staff) return;
    const id = Number(req.params.id);
    const { rows } = await pool.query(`DELETE FROM protected_regions WHERE id = $1 RETURNING *`, [id]);
    await reloadRegions();
    if (rows[0]) hub.broadcast({ t: "region", op: "remove", region: rows[0] });
    await audit(staff.id, "region.remove", { id }, null);
    return reply.send({ ok: true });
  });

  // ---- global freeze (admin only) -----------------------------------------
  app.post<{ Body: { on: boolean } }>("/api/admin/freeze", async (req, reply) => {
    const staff = await admin(req, reply);
    if (!staff) return;
    await setFrozen(Boolean(req.body.on));
    await audit(staff.id, "freeze", req.body, null);
    return reply.send({ ok: true, frozen: Boolean(req.body.on) });
  });

  // ---- corruption events (mod: visibility + a manual escape hatch) --------
  app.get("/api/admin/events", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    return reply.send({ current: events.current(), history: await events.history() });
  });

  app.post("/api/admin/events/end", async (req, reply) => {
    const staff = await mod(req, reply);
    if (!staff) return;
    const ended = await events.forceEnd();
    if (ended) await audit(staff.id, "event.end", {}, null);
    return reply.send({ ok: ended });
  });

  // ---- image stamp (admin only) -------------------------------------------
  app.post<{ Body: StampInput }>("/api/admin/stamp", async (req, reply) => {
    const staff = await admin(req, reply);
    if (!staff) return;
    try {
      return reply.send(await stamp(req.body, staff.id));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status === 500) req.log.error({ err }, "stamp failed");
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  // ---- templates (mod: the moderation surface shareable links create) -----
  app.get("/api/admin/templates", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    // Reported first, then newest. A moderator's time goes to what somebody
    // actually complained about, not to scrolling a list.
    const { rows } = await pool.query(
      `SELECT t.id, t.x, t.y, t.w, t.h, t.views, t.created_at, t.removed_at,
              count(r.session_id)::int AS reports,
              encode(t.data, 'base64') AS data
         FROM templates t
         LEFT JOIN template_reports r ON r.template_id = t.id
        GROUP BY t.id
        ORDER BY count(r.session_id) DESC, t.created_at DESC
        LIMIT 50`,
    );
    return reply.send(rows);
  });

  app.post<{ Params: { id: string }; Body: { removed: boolean } }>(
    "/api/admin/templates/:id/remove",
    async (req, reply) => {
      const staff = await mod(req, reply);
      if (!staff) return;
      const removed = req.body?.removed !== false;
      // Soft delete: /t/:id stops resolving, but the row stays so the same
      // image cannot be quietly republished without it being obvious.
      await pool.query(`UPDATE templates SET removed_at = $2 WHERE id = $1`, [
        req.params.id,
        removed ? new Date() : null,
      ]);
      await audit(staff.id, "template.remove", { id: req.params.id, removed }, null);
      return reply.send({ ok: true });
    },
  );

  // ---- area reports: the input side of moderation (mod) -------------------
  // Anyone can flag a bbox via POST /api/report (routes/reports.ts); this is
  // where a mod triages the queue it feeds. Oldest open report first — a
  // queue that surfaces newest-first lets old reports rot unseen forever.
  app.get<{ Querystring: { status?: string } }>("/api/admin/reports", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    const status = ["open", "dismissed", "reverted", "all"].includes(req.query.status ?? "")
      ? req.query.status!
      : "open";
    const { rows } = await pool.query(
      `SELECT r.id, r.x0, r.y0, r.x1, r.y1, r.reason, r.status, r.created_at,
              r.session_id, r.ip::text AS ip, rs.display_name AS resolved_by
         FROM area_reports r
         LEFT JOIN users rs ON rs.id = r.resolved_by
        WHERE $1 = 'all' OR r.status = $1
        ORDER BY (r.status = 'open') DESC, r.created_at ASC
        LIMIT 100`,
      [status],
    );
    // One extra query per row, but this is a small, infrequently-loaded page
    // (LIMIT 100, mod-only) — not worth a join that fans out per event.
    const withSuspects = await Promise.all(
      rows.map(async (r) => ({ ...r, suspects: await reportSuspects(r.x0, r.y0, r.x1, r.y1) })),
    );
    return reply.send(withSuspects);
  });

  app.get<{ Params: { id: string } }>("/api/admin/reports/:id/thumb.png", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    const { rows } = await pool.query<{ x0: number; y0: number; x1: number; y1: number }>(
      `SELECT x0, y0, x1, y1 FROM area_reports WHERE id = $1`,
      [Number(req.params.id)],
    );
    const r = rows[0];
    if (!r) return reply.code(404).send();
    const png = await renderReportThumbnail(r.x0, r.y0, r.x1, r.y1);
    reply.header("content-type", "image/png");
    reply.header("cache-control", "no-store"); // the whole point is "current state"
    return reply.send(png);
  });

  app.post<{ Params: { id: string }; Body: { action: "dismiss" | "revert" } }>(
    "/api/admin/reports/:id/resolve",
    async (req, reply) => {
      const staff = await mod(req, reply);
      if (!staff) return;
      const id = Number(req.params.id);
      const { rows } = await pool.query<{ x0: number; y0: number; x1: number; y1: number; status: string }>(
        `SELECT x0, y0, x1, y1, status FROM area_reports WHERE id = $1`,
        [id],
      );
      const report = rows[0];
      if (!report) return reply.code(404).send();
      if (report.status !== "open") return reply.code(409).send({ error: "already resolved" });

      const action = req.body?.action;
      if (action !== "dismiss" && action !== "revert") {
        return reply.code(400).send({ error: "action must be 'dismiss' or 'revert'" });
      }

      let revertResult = null;
      if (action === "revert") {
        // Bbox-only, same as a mod running the Revert tab with just an area
        // drawn and no time window — restores each pixel to its state before
        // whatever is in the report's bbox happened.
        revertResult = await revert(
          { bbox: { x0: report.x0, y0: report.y0, x1: report.x1, y1: report.y1 } },
          staff.id,
        );
      }

      await pool.query(
        `UPDATE area_reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`,
        [id, action === "revert" ? "reverted" : "dismissed", staff.id],
      );
      await audit(staff.id, "report.resolve", { id, action }, revertResult?.affected ?? null);
      return reply.send({ ok: true, revert: revertResult });
    },
  );

  // ---- alliances (mod: same moderation surface as templates/reports) ------
  app.get("/api/admin/alliances", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.color, a.created_at, a.disabled_at,
              (SELECT count(*)::int FROM sessions s WHERE s.alliance_id = a.id) AS members
         FROM alliances a
        ORDER BY a.disabled_at IS NOT NULL, a.created_at DESC`,
    );
    return reply.send(rows);
  });

  app.post<{ Params: { id: string }; Body: { disabled: boolean } }>(
    "/api/admin/alliances/:id/disable",
    async (req, reply) => {
      const staff = await mod(req, reply);
      if (!staff) return;
      const id = Number(req.params.id);
      // alliances.id is a SMALLINT — outside this range Postgres itself
      // refuses with a numeric-overflow error rather than "no rows".
      if (!Number.isInteger(id) || id < 0 || id > 32767) {
        return reply.code(400).send({ error: "id must be a valid alliance id" });
      }
      const disabled = req.body?.disabled !== false;

      await pool.query(`UPDATE alliances SET disabled_at = $2 WHERE id = $1`, [
        id,
        disabled ? new Date() : null,
      ]);

      if (disabled) {
        // Same reasoning as staff.disable cutting sessions: a disabled
        // alliance should stop representing anyone immediately, not just
        // stop appearing in the leaderboard.
        await pool.query(`UPDATE sessions SET alliance_id = NULL WHERE alliance_id = $1`, [id]);
        alliances.remove(id);
      } else {
        await alliances.reload(id);
      }

      await audit(staff.id, "alliance.disable", { id, disabled }, null);
      return reply.send({ ok: true });
    },
  );

  // ---- player accounts (mod: search/view, same tier as alliances) ---------
  app.get<{ Querystring: { q?: string } }>("/api/admin/users", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    const q = (req.query.q ?? "").trim();
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.email_verified_at, u.disabled_at, u.created_at, u.role,
              COALESCE(s.cumulative, 0) AS cumulative, COALESCE(s.held, 0) AS held
         FROM users u
         LEFT JOIN user_stats s ON s.user_id = u.id
        WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%'
        ORDER BY u.disabled_at IS NOT NULL, u.created_at DESC
        LIMIT 50`,
      [q],
    );
    return reply.send(rows);
  });

  app.post<{ Params: { id: string }; Body: { disabled: boolean } }>(
    "/api/admin/users/:id/disable",
    async (req, reply) => {
      const staff = await mod(req, reply);
      if (!staff) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return reply.code(400).send({ error: "id must be a valid user id" });
      }
      const disabled = req.body?.disabled !== false;
      const rows = await tx(async (c) => {
        const updated = await c.query(`UPDATE users SET disabled_at = $2 WHERE id = $1 RETURNING id`, [
          id,
          disabled ? new Date() : null,
        ]);
        if (disabled && updated.rows[0]) {
          await c.query(`DELETE FROM user_sessions WHERE user_id = $1`, [id]);
          await c.query(`UPDATE sessions SET user_id = NULL WHERE user_id = $1`, [id]);
        }
        return updated.rows;
      });
      if (!rows[0]) return reply.code(404).send();
      // Disabling must cut existing sessions, not just block future logins —
      // same reasoning as staff.disable and alliance.disable.
      await audit(staff.id, "user.disable", { id, disabled }, null);
      return reply.send({ ok: true });
    },
  );

  // ---- staff role (admin only) ---------------------------------------------
  // Staff is a role on an existing player account, not a separate account —
  // grant it here, or from the same control on the Users tab. There is no
  // staff session to revoke separately: getStaff() re-reads this column on
  // every request, so a role change (or an account disable, above) takes
  // effect on the granted user's very next request.
  app.post<{ Params: { id: string }; Body: { role: "mod" | "admin" | null } }>(
    "/api/admin/users/:id/role",
    async (req, reply) => {
      const staff = await admin(req, reply);
      if (!staff) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return reply.code(400).send({ error: "id must be a valid user id" });
      }
      const role = req.body?.role ?? null;
      if (role !== null && role !== "mod" && role !== "admin") {
        return reply.code(400).send({ error: "role must be mod, admin, or null" });
      }
      // Locking yourself out mid-incident is not a recoverable mistake from
      // inside the panel.
      if (id === staff.id && role === null) {
        return reply.code(400).send({ error: "you cannot revoke your own admin role" });
      }
      const { rows } = await pool.query(`UPDATE users SET role = $2 WHERE id = $1 RETURNING id`, [
        id,
        role,
      ]);
      if (!rows[0]) return reply.code(404).send();
      await audit(staff.id, "user.role", { id, role }, null);
      return reply.send({ ok: true });
    },
  );

  // ---- staff overview + audit (admin only) ---------------------------------
  app.get("/api/admin/audit", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const { rows } = await pool.query(
      `SELECT a.*, s.display_name AS username FROM audit_log a
         LEFT JOIN users s ON s.id = a.staff_id
        ORDER BY a.id DESC LIMIT 200`,
    );
    return reply.send(rows);
  });

  app.get("/api/admin/staff", async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const { rows } = await pool.query(
      `SELECT id, display_name AS username, email, role, disabled_at, created_at
         FROM users WHERE role IS NOT NULL ORDER BY role DESC, display_name`,
    );
    return reply.send(rows);
  });
}

async function audit(
  staffId: number,
  action: string,
  params: unknown,
  affected: number | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (staff_id, action, params, affected) VALUES ($1,$2,$3::jsonb,$4)`,
    [staffId, action, JSON.stringify(params), affected],
  );
}
