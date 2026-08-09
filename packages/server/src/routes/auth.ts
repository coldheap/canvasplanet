/**
 * Player accounts (ROADMAP.md §5.1) — email/password signup and login.
 *
 * Deliberately separate from session.ts's anonymous session: `users` and
 * `user_sessions` are their own tables, and `sessions.user_id` (nullable) is
 * the only link between the two, set here at signup/login on whichever
 * session cookie the browser currently holds. Anonymous play is completely
 * unaffected — nothing here touches the charge bank, bans, or the IP budget.
 *
 * Mirrors staff.ts's shape closely (argon2id, a hashed opaque token cookie,
 * a constant-time-ish verify-even-on-miss login), with one addition: email
 * must be verified (a token emailed via email/mailer.ts) before login works.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  DISCORD_STATE_COOKIE,
  DISCORD_STATE_TTL_SECONDS,
  DISPLAY_NAME_MAX_LEN,
  DISPLAY_NAME_MIN_LEN,
  DISPLAY_NAME_PATTERN,
  EMAIL_VERIFY_RESEND_COOLDOWN_MS,
  EMAIL_VERIFY_TTL_HOURS,
  PASSWORD_MIN_LEN,
  PASSWORD_RESET_COOLDOWN_MS,
  PASSWORD_RESET_TTL_HOURS,
  USER_COOKIE,
  USER_SESSION_TTL_DAYS,
  type UserDTO,
} from "@worldcanvas/shared";
import argon2 from "argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../email/mailer.js";
import { env } from "../env.js";
import { players } from "../players/store.js";
import { getOrCreateSession } from "../session/session.js";

export interface AuthUser {
  id: number;
  /** Null for a Discord-only account with no verified email on file. */
  email: string | null;
  displayName: string;
}

const hash = (t: string) => createHash("sha256").update(t).digest();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeSignup(
  body: Partial<{ email: string; password: string; displayName: string }>,
): { email: string; password: string; displayName: string } | { error: string } {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";

  if (!EMAIL_PATTERN.test(email)) return { error: "enter a valid email address" };
  if (password.length < PASSWORD_MIN_LEN) {
    return { error: `password must be at least ${PASSWORD_MIN_LEN} characters` };
  }
  if (
    displayName.length < DISPLAY_NAME_MIN_LEN ||
    displayName.length > DISPLAY_NAME_MAX_LEN ||
    !DISPLAY_NAME_PATTERN.test(displayName)
  ) {
    return {
      error: `display name must be ${DISPLAY_NAME_MIN_LEN}-${DISPLAY_NAME_MAX_LEN} characters (letters, numbers, spaces, . _ -)`,
    };
  }
  return { email, password, displayName };
}

/**
 * A minimal in-memory sliding window, not a DB table — this is a login-form
 * abuse guard, not a first-class rate limit the way reports/alliances have
 * (those count real rows for legitimate business reasons). Resetting on
 * restart is fine for what this defends against.
 */
const loginAttempts = new Map<string, { count: number; windowStart: number }>();
const LOGIN_WINDOW_MS = 15 * 60_000;

/**
 * Attempts allowed per IP per window.
 *
 * Configurable because every client of a local server shares one IP
 * (127.0.0.1): the verify suite exercises signup, wrong-password, pre-
 * verification and post-reset logins, so two runs inside the window exhaust
 * a 20-attempt budget and every later check fails with 429 for reasons that
 * have nothing to do with what it is testing.
 *
 * The default stays strict — this is raised for local runs only, never in
 * production, where 20 failed logins from one address in 15 minutes is
 * already generous.
 */
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 20);

function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

async function createVerificationToken(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [userId, hash(token), EMAIL_VERIFY_TTL_HOURS],
  );
  return token;
}

function issueUserSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(USER_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    path: "/",
    maxAge: USER_SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

async function issueUserSession(userId: number, reply: FastifyReply): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [userId, hash(token), USER_SESSION_TTL_DAYS],
  );
  issueUserSessionCookie(reply, token);
}

export async function getAuthUser(req: FastifyRequest): Promise<AuthUser | null> {
  const token = req.cookies[USER_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query<{ id: number; email: string | null; display_name: string }>(
    `SELECT u.id, u.email, u.display_name
       FROM user_sessions us
       JOIN users u ON u.id = us.user_id
      WHERE us.token_hash = $1 AND us.expires_at > now() AND u.disabled_at IS NULL`,
    [hash(token)],
  );
  const r = rows[0];
  return r ? { id: r.id, email: r.email, displayName: r.display_name } : null;
}

export async function getUserDTO(
  userId: number,
  email: string | null,
  displayName: string,
): Promise<UserDTO> {
  const { rows } = await pool.query<{
    cumulative: number;
    held: number;
    streak_days: number;
    best_streak: number;
  }>(`SELECT cumulative, held, streak_days, best_streak FROM user_stats WHERE user_id = $1`, [userId]);
  const s = rows[0];
  return {
    id: userId,
    email,
    displayName,
    cumulative: s?.cumulative ?? 0,
    held: s?.held ?? 0,
    streakDays: s?.streak_days ?? 0,
    bestStreak: s?.best_streak ?? 0,
  };
}

function sanitizeDisplayNameBase(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_. -]/g, "").trim().slice(0, DISPLAY_NAME_MAX_LEN);
  return cleaned.length >= DISPLAY_NAME_MIN_LEN ? cleaned : "Player";
}

/**
 * A Discord username can collide with an existing display name, or (once
 * stripped of the unicode/emoji DISPLAY_NAME_PATTERN doesn't allow) become
 * too short to use at all — unlike email/password signup, there is no form
 * for the player to correct that on, so this disambiguates for them instead
 * of failing the whole login.
 */
async function uniqueDisplayNameFrom(rawUsername: string): Promise<string> {
  const base = sanitizeDisplayNameBase(rawUsername);
  let candidate = base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE display_name = $1`, [candidate]);
    if (!rows[0]) return candidate;
    const suffix = randomBytes(2).toString("hex"); // 4 hex chars
    candidate = `${base.slice(0, DISPLAY_NAME_MAX_LEN - suffix.length - 1)}_${suffix}`;
  }
  return `Player_${randomBytes(4).toString("hex")}`;
}

export interface DiscordProfile {
  id: string;
  username: string;
  email?: string | null;
  verified?: boolean;
}

/**
 * Three cases, in order: an account already linked to this Discord id (the
 * normal repeat-login path); an existing email/password account whose
 * address matches a *verified* Discord email (Discord already proved
 * ownership, so this links rather than bouncing off the email UNIQUE
 * constraint with a 409 that would strand the same person with no way
 * forward); or nobody home, so a brand-new password-less account is created.
 */
export async function findOrCreateDiscordUser(profile: DiscordProfile): Promise<number> {
  const { rows: byDiscord } = await pool.query<{ id: number }>(
    `SELECT id FROM users WHERE discord_id = $1`,
    [profile.id],
  );
  if (byDiscord[0]) return byDiscord[0].id;

  const email = profile.email && profile.verified ? profile.email.trim().toLowerCase() : null;

  if (email) {
    const { rows: byEmail } = await pool.query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [
      email,
    ]);
    if (byEmail[0]) {
      await pool.query(
        `UPDATE users SET discord_id = $2, email_verified_at = COALESCE(email_verified_at, now())
          WHERE id = $1`,
        [byEmail[0].id, profile.id],
      );
      return byEmail[0].id;
    }
  }

  const displayName = await uniqueDisplayNameFrom(profile.username);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash, display_name, discord_id, email_verified_at)
     VALUES ($1, NULL, $2, $3, $4) RETURNING id`,
    [email, displayName, profile.id, email ? new Date() : null],
  );
  const userId = rows[0]!.id;
  await pool.query(`INSERT INTO user_stats (user_id) VALUES ($1)`, [userId]);
  players.register(userId, displayName);
  return userId;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post<{ Body: { email?: string; password?: string; displayName?: string } }>(
    "/api/auth/signup",
    async (req, reply) => {
      const result = normalizeSignup(req.body ?? {});
      if ("error" in result) return reply.code(400).send({ error: result.error });
      const { email, password, displayName } = result;

      const passwordHash = await argon2.hash(password);

      let userId: number;
      try {
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id`,
          [email, passwordHash, displayName],
        );
        userId = rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          return reply.code(409).send({ error: "that email or display name is already taken" });
        }
        throw err;
      }

      await pool.query(`INSERT INTO user_stats (user_id) VALUES ($1)`, [userId]);
      players.register(userId, displayName);

      const token = await createVerificationToken(userId);
      const verifyUrl = `${env.publicUrl}/api/auth/verify?token=${token}`;
      await sendVerificationEmail(email, verifyUrl);

      return reply.send({ ok: true, message: "check your email to verify your account" });
    },
  );

  // A browser navigates here directly from the emailed link (not a fetch
  // call), so the response is a redirect back into the app with a query flag
  // rather than JSON — the same round trip a click on an emailed link always
  // takes elsewhere on the web.
  app.get<{ Querystring: { token?: string } }>("/api/auth/verify", async (req, reply) => {
    const token = req.query.token;
    if (!token) return reply.redirect(`${env.publicUrl}/?verify_error=1`);

    const { rows } = await pool.query<{ id: number; user_id: number }>(
      `SELECT id, user_id FROM email_verifications
        WHERE token_hash = $1 AND expires_at > now() AND consumed_at IS NULL`,
      [hash(token)],
    );
    const row = rows[0];
    if (!row) return reply.redirect(`${env.publicUrl}/?verify_error=1`);

    await pool.query(`UPDATE email_verifications SET consumed_at = now() WHERE id = $1`, [row.id]);
    await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [row.user_id]);

    // Verifying doubles as a first login — no separate "now sign in" step for
    // someone who just proved they own the address. That means it must also
    // do what /api/auth/login does: attach this browser's current anonymous
    // session to the account, or paint attribution silently never starts
    // until the player happens to log in again explicitly.
    await issueUserSession(row.user_id, reply);
    const session = await getOrCreateSession(req, reply);
    await pool.query(`UPDATE sessions SET user_id = $2 WHERE id = $1`, [session.id, row.user_id]);

    return reply.redirect(`${env.publicUrl}/?verified=1`);
  });

  app.post<{ Body: { email?: string } }>("/api/auth/resend-verification", async (req, reply) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!EMAIL_PATTERN.test(email)) return reply.code(400).send({ error: "enter a valid email address" });

    const { rows } = await pool.query<{ id: number; email_verified_at: Date | null }>(
      `SELECT id, email_verified_at FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];
    // Same shape as this file's "always look busy" replies elsewhere: do not
    // reveal whether the address has an account at all.
    if (!user || user.email_verified_at) {
      return reply.send({ ok: true, message: "if that account exists and is unverified, an email was sent" });
    }

    const { rows: recent } = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM email_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    const last = recent[0]?.created_at;
    if (last && Date.now() - last.getTime() < EMAIL_VERIFY_RESEND_COOLDOWN_MS) {
      return reply.code(429).send({ error: "already sent — try again in a minute" });
    }

    const token = await createVerificationToken(user.id);
    const verifyUrl = `${env.publicUrl}/api/auth/verify?token=${token}`;
    await sendVerificationEmail(email, verifyUrl);
    return reply.send({ ok: true, message: "if that account exists and is unverified, an email was sent" });
  });

  // Unlike /verify, there is nothing for the server to *do* the moment this
  // link is clicked — the account isn't changed until a new password is
  // submitted — so the email points straight at the app with the token as a
  // query param (App.tsx picks it up and shows the "choose a new password"
  // form) rather than through a server redirect route.
  app.post<{ Body: { email?: string } }>("/api/auth/request-reset", async (req, reply) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!EMAIL_PATTERN.test(email)) return reply.code(400).send({ error: "enter a valid email address" });

    const generic = { ok: true, message: "if that account exists, a reset link was sent" };

    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]);
    const user = rows[0];
    if (!user) return reply.send(generic); // do not reveal whether the account exists

    const { rows: recent } = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM password_resets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    const last = recent[0]?.created_at;
    if (last && Date.now() - last.getTime() < PASSWORD_RESET_COOLDOWN_MS) {
      // Cooldown still counts as "sent" to the caller — only the enumeration
      // guard above is allowed to answer differently.
      return reply.send(generic);
    }

    const token = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
      [user.id, hash(token), PASSWORD_RESET_TTL_HOURS],
    );
    const resetUrl = `${env.publicUrl}/?resetToken=${token}`;
    await sendPasswordResetEmail(email, resetUrl);
    return reply.send(generic);
  });

  app.post<{ Body: { token?: string; password?: string } }>("/api/auth/reset", async (req, reply) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token) return reply.code(400).send({ error: "missing token" });
    if (password.length < PASSWORD_MIN_LEN) {
      return reply.code(400).send({ error: `password must be at least ${PASSWORD_MIN_LEN} characters` });
    }

    const { rows } = await pool.query<{ id: number; user_id: number }>(
      `SELECT id, user_id FROM password_resets
        WHERE token_hash = $1 AND expires_at > now() AND consumed_at IS NULL`,
      [hash(token)],
    );
    const row = rows[0];
    if (!row) return reply.code(400).send({ error: "invalid or expired reset link" });

    const passwordHash = await argon2.hash(password);
    await pool.query(`UPDATE password_resets SET consumed_at = now() WHERE id = $1`, [row.id]);
    // A reset link proves inbox ownership exactly as much as the verify link
    // does — an account that requested a reset before ever verifying gets
    // verified here too, rather than being stuck unable to log in either way.
    await pool.query(
      `UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
      [row.user_id, passwordHash],
    );
    // A live reset link is a stronger capability than a session cookie —
    // anyone who had one (a stolen device, a shared computer) loses it here.
    await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [row.user_id]);

    await issueUserSession(row.user_id, reply);
    // Same as /api/auth/verify: this doubles as a login, so it must also
    // attach this browser's current anonymous session to the account or
    // paint attribution silently never starts.
    const session = await getOrCreateSession(req, reply);
    await pool.query(`UPDATE sessions SET user_id = $2 WHERE id = $1`, [session.id, row.user_id]);

    const { rows: userRows } = await pool.query<{ email: string; display_name: string }>(
      `SELECT email, display_name FROM users WHERE id = $1`,
      [row.user_id],
    );
    const user = await getUserDTO(row.user_id, userRows[0]!.email, userRows[0]!.display_name);
    return reply.send({ ok: true, user });
  });

  app.post<{ Body: { email?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
    if (loginRateLimited(req.ip)) {
      return reply.code(429).send({ error: "too many attempts, try again later" });
    }

    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    const { rows } = await pool.query<{
      id: number;
      password_hash: string | null;
      display_name: string;
      email_verified_at: Date | null;
      disabled_at: Date | null;
    }>(
      `SELECT id, password_hash, display_name, email_verified_at, disabled_at FROM users WHERE email = $1`,
      [email],
    );
    const row = rows[0];

    // Always run a verify, even with no matching user — same reasoning as
    // staff.ts: response timing must not reveal which emails have accounts.
    // A Discord-only account has no password_hash at all (null, not a
    // mismatch) — that must fail the same generic way, not throw inside
    // argon2.verify, and it must not reveal "this account uses Discord"
    // either (same enumeration-resistance the rest of this file follows).
    const ok =
      row && row.password_hash
        ? await argon2.verify(row.password_hash, password)
        : (await argon2.hash(password || "x"), false);
    if (!ok || !row) return reply.code(401).send({ error: "wrong email or password" });
    if (row.disabled_at) return reply.code(403).send({ error: "this account has been disabled" });
    if (!row.email_verified_at) {
      return reply.code(403).send({ error: "verify your email before logging in" });
    }

    await issueUserSession(row.id, reply);

    // Attach this browser's current anonymous session to the account, so
    // paint attribution starts immediately — the whole point of logging in
    // on a device that's already been painting anonymously.
    const session = await getOrCreateSession(req, reply);
    await pool.query(`UPDATE sessions SET user_id = $2 WHERE id = $1`, [session.id, row.id]);

    const user = await getUserDTO(row.id, email, row.display_name);
    return reply.send({ ok: true, user });
  });

  // A plain browser navigation (an <a href>, not a fetch call) — Discord's
  // own authorize screen is what the user actually interacts with next, so
  // this just redirects straight there with a CSRF state token round-tripped
  // through a short-lived cookie, the standard OAuth authorization-code shape.
  app.get("/api/auth/discord", async (req, reply) => {
    if (!env.discord.enabled) return reply.code(404).send();

    const state = randomBytes(16).toString("base64url");
    reply.setCookie(DISCORD_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProd,
      path: "/",
      maxAge: DISCORD_STATE_TTL_SECONDS,
    });

    const url = new URL("https://discord.com/api/oauth2/authorize");
    url.searchParams.set("client_id", env.discord.clientId);
    url.searchParams.set("redirect_uri", `${env.publicUrl}/api/auth/discord/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify email");
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  // Discord redirects the browser back here after the user approves (or
  // denies) the request. Same "browser navigation, not JSON" shape as
  // /api/auth/verify — this ends in a redirect with a query flag, not a
  // response body.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/discord/callback",
    async (req, reply) => {
      if (!env.discord.enabled) return reply.code(404).send();

      const cookieState = req.cookies[DISCORD_STATE_COOKIE];
      reply.clearCookie(DISCORD_STATE_COOKIE, { path: "/" });
      const { code, state, error } = req.query;

      if (error || !code || !state || !cookieState || state !== cookieState) {
        return reply.redirect(`${env.publicUrl}/?discord_error=1`);
      }

      try {
        const redirectUri = `${env.publicUrl}/api/auth/discord/callback`;
        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.discord.clientId,
            client_secret: env.discord.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
          }),
        });
        if (!tokenRes.ok) throw new Error(`token exchange failed: HTTP ${tokenRes.status}`);
        const token = (await tokenRes.json()) as { access_token: string };

        const meRes = await fetch("https://discord.com/api/users/@me", {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        if (!meRes.ok) throw new Error(`user fetch failed: HTTP ${meRes.status}`);
        const profile = (await meRes.json()) as DiscordProfile;

        const userId = await findOrCreateDiscordUser(profile);

        const { rows: disabledRows } = await pool.query<{ disabled_at: Date | null }>(
          `SELECT disabled_at FROM users WHERE id = $1`,
          [userId],
        );
        if (disabledRows[0]?.disabled_at) {
          return reply.redirect(`${env.publicUrl}/?discord_error=1`);
        }

        await issueUserSession(userId, reply);
        // Same as /api/auth/login: attach this browser's current anonymous
        // session to the account, so paint attribution starts immediately.
        const session = await getOrCreateSession(req, reply);
        await pool.query(`UPDATE sessions SET user_id = $2 WHERE id = $1`, [session.id, userId]);

        return reply.redirect(`${env.publicUrl}/?discord=1`);
      } catch (err) {
        req.log.error({ err }, "discord oauth failed");
        return reply.redirect(`${env.publicUrl}/?discord_error=1`);
      }
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[USER_COOKIE];
    if (token) {
      await pool.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [hash(token)]);
    }
    reply.clearCookie(USER_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    const user = await getAuthUser(req);
    if (!user) return reply.code(404).send();
    return reply.send(await getUserDTO(user.id, user.email, user.displayName));
  });
}
