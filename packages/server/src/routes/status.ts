/**
 * Public status — safe to point an uptime monitor at, and what backs both
 * status pages (in-app Settings → System status, and the standalone
 * `status.<domain>` subdomain served by Caddy).
 *
 * No auth: nothing in either response identifies a user or an IP address.
 * See src/status/snapshot.ts for the health check itself and
 * src/status/history.ts for the persisted uptime record.
 */

import { STATUS_HISTORY_MAX_DAYS } from "@worldcanvas/shared";
import type { FastifyInstance } from "fastify";
import { dailyHistory } from "../status/history.js";
import { computeStatus } from "../status/snapshot.js";

export function registerStatusRoutes(app: FastifyInstance): void {
  app.get("/api/status", async (_req, reply) => {
    const snapshot = await computeStatus();
    // Never cached at any layer: a status page showing an outage from ten
    // minutes ago is worse than a slightly slower one that is always current.
    reply.header("Cache-Control", "no-store");
    return reply.code(snapshot.ok ? 200 : 503).send(snapshot);
  });

  app.get<{ Querystring: { days?: string } }>("/api/status/history", async (req, reply) => {
    const requested = Number(req.query.days);
    const result = await dailyHistory(Number.isFinite(requested) ? requested : STATUS_HISTORY_MAX_DAYS);
    reply.header("Cache-Control", "no-store");
    return reply.send(result);
  });
}
