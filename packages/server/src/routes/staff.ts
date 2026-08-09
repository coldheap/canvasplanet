/**
 * Staff authorization.
 *
 * There is no separate staff account or login anymore — "staff" is just a
 * nullable role (`mod` | `admin`) on an ordinary player account, granted by
 * an admin from the Users tab (see routes/admin.ts's
 * POST /api/admin/users/:id/role). Sign in as yourself; the Admin tab
 * appears only if your account has a role, and the server re-derives that
 * role from `users` on every request — there is no separate staff session to
 * revoke, so a role change (or account disable) takes effect on the very
 * next request.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { getAuthUser } from "./auth.js";

export type Role = "mod" | "admin";
export interface Staff {
  id: number;
  username: string;
  role: Role;
}

export async function getStaff(req: FastifyRequest): Promise<Staff | null> {
  const user = await getAuthUser(req);
  if (!user || !user.role) return null;
  return { id: user.id, username: user.displayName, role: user.role };
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
