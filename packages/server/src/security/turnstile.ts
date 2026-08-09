/**
 * Anti-bot layer 1 — Cloudflare Turnstile on a session's first paint.
 *
 * The first POST /api/paint from an unverified session returns 428 with the
 * sitekey. The client renders an invisible widget, retries with the token,
 * and the session is marked verified forever. Cost to a real human: usually
 * zero interaction. Cost to a headless script: it has to solve a challenge
 * per session, which makes cookie-farming a bot's most expensive operation
 * rather than its cheapest.
 *
 * Blank env keys disable this entirely (the dev default).
 */

import { pool } from "../db/pool.js";
import { env } from "../env.js";

export function isEnabled(): boolean {
  return env.turnstile.enabled;
}

export function sitekey(): string | null {
  return env.turnstile.enabled ? env.turnstile.sitekey : null;
}

export async function verify(token: string, ip: string): Promise<boolean> {
  if (!env.turnstile.enabled) return true;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.turnstile.secret, response: token, remoteip: ip }),
    });
    const body = (await res.json()) as { success?: boolean };
    return body.success === true;
  } catch (err) {
    // Fail CLOSED. If Cloudflare is unreachable we would rather block paints
    // for a minute than hand an attacker a free bypass by pretending success.
    console.error("[turnstile] verify failed", err);
    return false;
  }
}

export async function markVerified(sessionId: number): Promise<void> {
  await pool.query(`UPDATE sessions SET turnstile_ok = true WHERE id = $1`, [sessionId]);
}
