/**
 * "Report this area" — anyone can flag a bbox for a moderator to look at.
 *
 * See admin/reports.ts for the queue itself and PLAN.md-equivalent reasoning
 * in ROADMAP.md §3.1. This route only accepts the report; everything a
 * moderator does with it lives behind /api/admin/reports in routes/admin.ts.
 */

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { normalizeSelector, type ReportSelector } from "../admin/reports.js";
import { clientIp, getOrCreateSession } from "../session/session.js";

/** Generous relative to how often any one person finds something worth
 *  flagging — this exists to stop a script from filling the queue, not to
 *  discourage a real report. */
const REPORTS_PER_HOUR = 20;

export function registerReportRoutes(app: FastifyInstance): void {
  app.post<{ Body: Partial<ReportSelector> }>("/api/report", async (req, reply) => {
    const session = await getOrCreateSession(req, reply);
    const sel = normalizeSelector(req.body ?? {});
    if ("error" in sel) return reply.code(sel.status).send({ error: sel.error });

    const { rows: recent } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM area_reports
        WHERE session_id = $1 AND created_at > now() - interval '1 hour'`,
      [session.id],
    );
    if ((recent[0]?.n ?? 0) >= REPORTS_PER_HOUR) {
      return reply.code(429).send({ error: "too many reports from this session, try again later" });
    }

    await pool.query(
      `INSERT INTO area_reports (x0, y0, x1, y1, reason, session_id, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sel.x0, sel.y0, sel.x1, sel.y1, sel.reason ?? null, session.id, clientIp(req)],
    );
    return reply.send({ ok: true });
  });
}
