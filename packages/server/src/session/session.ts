/**
 * Anonymous sessions.
 *
 * The cookie holds a random opaque token; only its sha256 is stored, so a
 * database leak does not hand out working sessions. httpOnly + SameSite=Lax
 * means no JS on the page can read it, which also means an injected script
 * cannot exfiltrate a session to drive it from elsewhere.
 *
 * A new session starts with a FULL bank of 30 charges (best first
 * impression). The containment for cookie-wiping is the IP token bucket in
 * paint/service.ts, not a smaller starting bank.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  CHARGE_START,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
} from "@worldcanvas/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { env } from "../env.js";
import { lookupAsn } from "../security/asn.js";

export interface Session {
  id: number;
  charges: number;
  chargesUpdatedAt: number;
  turnstileOk: boolean;
  lastCountryId: number | null;
  bannedUntil: number | null;
  allianceId: number | null;
  /** Charges regenerate EVENT_BONUS_MULTIPLIER times faster until this time —
   *  the corruption event's reward (ROADMAP.md Phase 7). Null for the vast
   *  majority of sessions that never defended a winning event. */
  eventBonusUntil: number | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest();

/** How stale `last_seen_at` may get before it is refreshed out of band. */
const SEEN_REFRESH_MS = 5 * 60_000;

/**
 * The client IP the rate limiter counts against.
 *
 * Cloudflare terminates TLS, so behind it the real client IP is in
 * CF-Connecting-IP and the socket address is a Cloudflare edge node.
 *
 * But this header is only trustworthy when something upstream *overwrites*
 * it. Reading it unconditionally means anyone who can reach the origin
 * directly sets `CF-Connecting-IP: <random>` per request and the entire IP
 * ceiling evaporates — every request looks like a brand-new address. The
 * plan keeps the origin IP unpublished, which is not the same as
 * unreachable.
 *
 * So it is read only when TRUST_CF_CONNECTING_IP is set, which is exactly
 * when a proxy that rewrites it is known to be in front.
 */
export function clientIp(req: FastifyRequest): string {
  if (env.trustCfConnectingIp) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.length > 0) return cf;
  }
  return req.ip;
}

export async function getOrCreateSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<Session> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    const existing = await findByToken(token);
    if (existing) return existing;
  }
  return createSession(req, reply);
}

/**
 * Read-only lookup, for contexts that cannot set a cookie.
 *
 * The WebSocket upgrade is the one that matters: a `Set-Cookie` on a 101
 * response is not reliably honoured, so /ws refuses rather than silently
 * minting a session the browser will never keep. The client always calls
 * /api/bootstrap first, which is where the cookie is issued.
 */
export async function findSession(req: FastifyRequest): Promise<Session | null> {
  const token = req.cookies[SESSION_COOKIE];
  return token ? findByToken(token) : null;
}

async function findByToken(token: string): Promise<Session | null> {
  // A READ, not a write.
  //
  // This used to be `UPDATE sessions SET last_seen_at = now() ... RETURNING`,
  // which made every single request — including every paint — its own write
  // transaction with its own WAL flush, immediately before the paint
  // transaction updated the very same row again. Two commits where one would
  // do, on the hottest path in the application.
  //
  // last_seen_at only needs to be roughly right (it drives session cleanup),
  // so it is refreshed at most once every SEEN_REFRESH_MS, out of band.
  const { rows } = await pool.query<{
    id: number;
    charges: number;
    charges_updated_at: Date;
    turnstile_ok: boolean;
    last_country_id: number | null;
    banned_until: Date | null;
    alliance_id: number | null;
    event_bonus_until: Date | null;
    stale: boolean;
  }>(
    `SELECT id, charges, charges_updated_at, turnstile_ok, last_country_id, banned_until, alliance_id,
            event_bonus_until,
            last_seen_at < now() - ($2 || ' milliseconds')::interval AS stale
       FROM sessions WHERE token_hash = $1`,
    [hash(token), SEEN_REFRESH_MS],
  );
  const r = rows[0];
  if (!r) return null;

  if (r.stale) {
    // Deliberately not awaited: nothing downstream reads it, and making the
    // request wait for a bookkeeping write is exactly what this change is
    // removing.
    void pool
      .query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [r.id])
      .catch(() => {});
  }

  return {
    id: r.id,
    charges: r.charges,
    chargesUpdatedAt: r.charges_updated_at.getTime(),
    turnstileOk: r.turnstile_ok,
    lastCountryId: r.last_country_id,
    bannedUntil: r.banned_until?.getTime() ?? null,
    allianceId: r.alliance_id,
    eventBonusUntil: r.event_bonus_until?.getTime() ?? null,
  };
}

async function createSession(req: FastifyRequest, reply: FastifyReply): Promise<Session> {
  const token = randomBytes(32).toString("base64url");
  const ip = clientIp(req);
  const ua = req.headers["user-agent"] ?? "";
  const asn = await lookupAsn(ip);

  const { rows } = await pool.query<{ id: number; charges_updated_at: Date }>(
    `INSERT INTO sessions (token_hash, charges, ip, asn, ua_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, charges_updated_at`,
    [hash(token), CHARGE_START, ip, asn?.number ?? null, createHash("sha256").update(ua).digest()],
  );
  const row = rows[0]!;

  // Flag the IP's bucket so the paint path can halve its budget without
  // needing to re-resolve the ASN on every request.
  if (asn?.flagged) {
    await pool.query(
      `INSERT INTO ip_budget (ip, flagged_asn) VALUES ($1, true)
       ON CONFLICT (ip) DO UPDATE SET flagged_asn = true`,
      [ip],
    );
  }

  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });

  return {
    id: row.id,
    charges: CHARGE_START,
    chargesUpdatedAt: row.charges_updated_at.getTime(),
    // A flagged ASN must pass Turnstile even for its first paint.
    turnstileOk: false,
    lastCountryId: null,
    bannedUntil: null,
    allianceId: null,
    eventBonusUntil: null,
  };
}
