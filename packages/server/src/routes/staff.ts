/**
 * Staff authentication.
 *
 * Real accounts with argon2id passwords, two roles. Staff sessions are a
 * separate cookie from the anonymous painter session — a staff member is
 * still an ordinary session for painting purposes, they just bypass the
 * charge bank and the IP budget.
 *
 * The panel appears in the app because /api/bootstrap reports `staff`; there
 * is no separate admin site to secure, and no secret URL to leak into
 * browser history.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { STAFF_COOKIE, STAFF_TTL_HOURS } from "@worldcanvas/shared";
import argon2 from "argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { env } from "../env.js";

export type Role = "mod" | "admin";
export interface Staff {
  id: number;
  username: string;
  role: Role;
}

const hash = (t: string) => createHash("sha256").update(t).digest();

export async function getStaff(req: FastifyRequest): Promise<Staff | null> {
  const token = req.cookies[STAFF_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query<Staff>(
    `SELECT s.id, s.username, s.role
       FROM staff_sessions ss
       JOIN staff s ON s.id = ss.staff_id
      WHERE ss.token_hash = $1
        AND ss.expires_at > now()
        AND s.disabled_at IS NULL`,
    [hash(token)],
  );
  return rows[0] ?? null;
}

/** Route guard. `admin` implies `mod`; see the permission matrix in PLAN.md §7. */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<Staff | undefined> => {
    const staff = await getStaff(req);
    if (!staff || (min === "admin" && staff.role !== "admin")) {
      // 404 rather than 403: an unauthenticated prober learns nothing about
      // which admin routes exist.
      await reply.code(404).send();
      return undefined;
    }
    return staff;
  };
}

export function registerStaffRoutes(app: FastifyInstance): void {
  app.post<{ Body: { username: string; password: string } }>(
    "/api/staff/login",
    async (req, reply) => {
      const { username, password } = req.body ?? ({} as never);
      const { rows } = await pool.query<{ id: number; password_hash: string; role: Role }>(
        `SELECT id, password_hash, role FROM staff
          WHERE username = $1 AND disabled_at IS NULL`,
        [username ?? ""],
      );
      const row = rows[0];

      // Always run a verify, even with no matching user, so response timing
      // does not reveal which usernames exist.
      const ok = row
        ? await argon2.verify(row.password_hash, password ?? "")
        : (await argon2.hash(password ?? "x"), false);

      if (!ok || !row) return reply.code(401).send({ ok: false });

      const token = randomBytes(32).toString("base64url");
      await pool.query(
        `INSERT INTO staff_sessions (staff_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
        [row.id, hash(token), STAFF_TTL_HOURS],
      );
      reply.setCookie(STAFF_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict", // stricter than the painter cookie: CSRF on
        secure: env.isProd, // /api/admin/revert would be a very bad day
        path: "/",
        maxAge: STAFF_TTL_HOURS * 3600,
      });
      return reply.send({ ok: true, role: row.role, username });
    },
  );

  app.post("/api/staff/logout", async (req, reply) => {
    const token = req.cookies[STAFF_COOKIE];
    if (token) {
      await pool.query(`DELETE FROM staff_sessions WHERE token_hash = $1`, [hash(token)]);
    }
    reply.clearCookie(STAFF_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });
}

/** Kept for the constant-time compare in future token-based flows. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
