import type { ChatMessageDTO } from "@canvasplanet/shared";
import type { FastifyInstance } from "fastify";
import { pool, tx } from "../db/pool.js";
import { CHAT_MAX_LENGTH } from "../chat/filter.js";
import { ChatError, createMessage, getMessage, listMessages } from "../chat/store.js";
import { hub } from "../ws/hub.js";
import { getAuthUser } from "./auth.js";
import { requireRole, type Staff } from "./staff.js";

const REPORTS_PER_HOUR = 20;

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function optionalReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ChatError("reason must be text", 400);
  const reason = value.trim();
  if ([...reason].length > CHAT_MAX_LENGTH) {
    throw new ChatError(`reason must be ${CHAT_MAX_LENGTH} characters or fewer`, 400);
  }
  return reason || null;
}

async function audit(staff: Staff, action: string, params: unknown, affected: number | null): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (staff_id, action, params, affected) VALUES ($1,$2,$3::jsonb,$4)`,
    [staff.id, action, JSON.stringify(params), affected],
  );
}

async function broadcastUpdate(id: number): Promise<ChatMessageDTO | null> {
  const message = await getMessage(id);
  if (message) hub.broadcastChat({ t: "chat_update", message });
  return message;
}

export function registerChatRoutes(app: FastifyInstance): void {
  const mod = requireRole("mod");

  // Public, read-only history. IDs paginate backwards without offset drift
  // while live messages are arriving.
  app.get<{ Querystring: { before?: string } }>("/api/chat/messages", async (req, reply) => {
    const before = req.query.before === undefined ? undefined : positiveId(req.query.before);
    if (before === null) {
      return reply.code(400).send({ error: "before must be a valid message id" });
    }
    return reply.send(await listMessages(before));
  });

  app.post<{ Body: { body?: unknown } }>("/api/chat/messages", async (req, reply) => {
    const user = await getAuthUser(req);
    if (!user) return reply.code(401).send({ error: "log in to send chat messages" });
    try {
      const message = await createMessage(user, req.body?.body);
      hub.broadcastChat({ t: "chat", message });
      return reply.code(201).send({ message });
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      if (error.retryAfterMs !== undefined) {
        reply.header("Retry-After", Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
      }
      return reply.code(error.status).send({ error: error.message, retryAfterMs: error.retryAfterMs });
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/api/chat/messages/:id/report",
    async (req, reply) => {
      const user = await getAuthUser(req);
      if (!user) return reply.code(401).send({ error: "log in to report a message" });
      const id = positiveId(req.params.id);
      if (!id) return reply.code(400).send({ error: "invalid message id" });
      try {
        const reason = optionalReason(req.body?.reason);
        const { rows: messages } = await pool.query<{ user_id: number; deleted_at: Date | null }>(
          `SELECT user_id, deleted_at FROM chat_messages WHERE id = $1`,
          [id],
        );
        const message = messages[0];
        if (!message || message.deleted_at) return reply.code(404).send();
        if (message.user_id === user.id) return reply.code(400).send({ error: "you cannot report your own message" });

        const { rows: recent } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM chat_reports
            WHERE reporter_id = $1 AND created_at > now() - interval '1 hour'`,
          [user.id],
        );
        if ((recent[0]?.n ?? 0) >= REPORTS_PER_HOUR) {
          return reply.code(429).send({ error: "too many reports, try again later" });
        }
        const { rowCount } = await pool.query(
          `INSERT INTO chat_reports (message_id, reporter_id, reason)
           VALUES ($1,$2,$3) ON CONFLICT (message_id, reporter_id) DO NOTHING`,
          [id, user.id, reason],
        );
        return reply.send({ ok: true, counted: rowCount === 1 });
      } catch (error) {
        if (error instanceof ChatError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    },
  );

  // ---- staff moderation -------------------------------------------------
  app.get<{ Querystring: { status?: string } }>("/api/admin/chat/reports", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    const status = req.query.status === "all" ? "all" : "open";
    const where = status === "open" ? "WHERE r.resolved_at IS NULL" : "";
    const { rows } = await pool.query(
      `SELECT r.id, r.reason, r.created_at, r.resolved_at, r.resolution,
              reporter.display_name AS reporter_name,
              m.id AS message_id, m.user_id, author.display_name,
              NULL::text AS avatar_revision,
              m.original_body, m.display_body, m.created_at AS message_created_at,
              m.deleted_at
         FROM chat_reports r
         JOIN chat_messages m ON m.id = r.message_id
         JOIN users author ON author.id = m.user_id
         JOIN users reporter ON reporter.id = r.reporter_id
         ${where}
        ORDER BY r.resolved_at IS NOT NULL, r.created_at ASC LIMIT 200`,
    );
    return reply.send(rows);
  });

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/api/admin/chat/messages/:id/delete",
    async (req, reply) => {
      const staff = await mod(req, reply);
      if (!staff) return;
      const id = positiveId(req.params.id);
      if (!id) return reply.code(400).send({ error: "invalid message id" });
      try {
        const reason = optionalReason(req.body?.reason);
        const affected = await tx(async (client) => {
          const result = await client.query(
            `UPDATE chat_messages
                SET deleted_at = COALESCE(deleted_at, now()),
                    deleted_by = COALESCE(deleted_by, $2),
                    delete_reason = COALESCE(delete_reason, $3)
              WHERE id = $1 RETURNING id`,
            [id, staff.id, reason],
          );
          if (!result.rows[0]) return 0;
          await client.query(
            `UPDATE chat_reports SET resolved_at = now(), resolved_by = $2, resolution = 'deleted'
              WHERE message_id = $1 AND resolved_at IS NULL`,
            [id, staff.id],
          );
          return 1;
        });
        if (!affected) return reply.code(404).send();
        await audit(staff, "chat.message.delete", { id, reason }, 1);
        return reply.send({ ok: true, message: await broadcastUpdate(id) });
      } catch (error) {
        if (error instanceof ChatError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { resolution?: string } }>(
    "/api/admin/chat/reports/:id/resolve",
    async (req, reply) => {
      const staff = await mod(req, reply);
      if (!staff) return;
      const id = positiveId(req.params.id);
      if (!id) return reply.code(400).send({ error: "invalid report id" });
      const resolution = req.body?.resolution === "dismissed" ? "dismissed" : "reviewed";
      const { rowCount } = await pool.query(
        `UPDATE chat_reports SET resolved_at = now(), resolved_by = $2, resolution = $3
          WHERE id = $1 AND resolved_at IS NULL`,
        [id, staff.id, resolution],
      );
      if (!rowCount) return reply.code(404).send();
      await audit(staff, "chat.report.resolve", { id, resolution }, 1);
      return reply.send({ ok: true });
    },
  );

  app.get("/api/admin/chat/mutes", async (req, reply) => {
    if (!(await mod(req, reply))) return;
    const { rows } = await pool.query(
      `SELECT cm.id, cm.user_id, u.display_name, cm.until_at, cm.reason, cm.created_at,
              staff.display_name AS created_by_name
         FROM chat_mutes cm
         JOIN users u ON u.id = cm.user_id
         JOIN users staff ON staff.id = cm.created_by
        WHERE cm.revoked_at IS NULL AND (cm.until_at IS NULL OR cm.until_at > now())
        ORDER BY cm.until_at IS NULL DESC, cm.created_at DESC`,
    );
    return reply.send(rows);
  });

  app.post<{ Params: { id: string }; Body: { hours?: number | null; reason?: unknown } }>(
    "/api/admin/chat/users/:id/mute",
    async (req, reply) => {
      const staff = await mod(req, reply);
      if (!staff) return;
      const userId = positiveId(req.params.id);
      if (!userId) return reply.code(400).send({ error: "invalid user id" });
      if (userId === staff.id) return reply.code(400).send({ error: "you cannot mute yourself" });
      const hours = req.body?.hours;
      if (hours !== null && (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 87_600)) {
        return reply.code(400).send({ error: "hours must be positive, or null for a permanent mute" });
      }
      try {
        const reason = optionalReason(req.body?.reason);
        const { rows: targets } = await pool.query<{ role: "mod" | "admin" | null }>(
          `SELECT role FROM users WHERE id = $1`,
          [userId],
        );
        const target = targets[0];
        if (!target) return reply.code(404).send();
        if (staff.role === "mod" && target.role) {
          return reply.code(403).send({ error: "moderators cannot mute staff accounts" });
        }
        const until = hours === null ? null : new Date(Date.now() + hours * 3_600_000);
        await tx(async (client) => {
          await client.query(
            `UPDATE chat_mutes SET revoked_at = now(), revoked_by = $2
              WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId, staff.id],
          );
          await client.query(
            `INSERT INTO chat_mutes (user_id, until_at, reason, created_by) VALUES ($1,$2,$3,$4)`,
            [userId, until, reason, staff.id],
          );
        });
        await audit(staff, "chat.user.mute", { userId, hours: hours ?? null, reason }, 1);
        return reply.send({ ok: true, until: until?.toISOString() ?? null });
      } catch (error) {
        if (error instanceof ChatError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/admin/chat/users/:id/unmute", async (req, reply) => {
    const staff = await mod(req, reply);
    if (!staff) return;
    const userId = positiveId(req.params.id);
    if (!userId) return reply.code(400).send({ error: "invalid user id" });
    const { rowCount } = await pool.query(
      `UPDATE chat_mutes SET revoked_at = now(), revoked_by = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, staff.id],
    );
    await audit(staff, "chat.user.unmute", { userId }, rowCount ?? 0);
    return reply.send({ ok: true });
  });
}
