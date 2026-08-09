/**
 * Grant (or update) a staff role on a player account.
 *
 *   pnpm staff:create -- --email alice@example.com --role admin
 *
 * Ops bootstrap only — this is the one way to make the very first admin,
 * since every other path to granting a role requires an existing admin to
 * click the button. If the email doesn't match an account yet, one is
 * created and marked verified (no email to click); the password comes from
 * BOOTSTRAP_ADMIN_PASSWORD or is generated and printed once. If it already
 * exists, only its role changes — the password is left alone.
 *
 * Roles: `mod` (revert, ban, inspect, unlimited pixels) and `admin`
 * (everything, plus regions, freeze, stamp, granting/revoking staff roles).
 */

import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { pool } from "../src/db/pool.js";
import { players } from "../src/players/store.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = (arg("email") ?? process.env.BOOTSTRAP_ADMIN_EMAIL)?.trim().toLowerCase();
  const role = (arg("role") ?? "admin") as "mod" | "admin";

  if (!email) {
    console.error("usage: pnpm staff:create -- --email <address> [--role mod|admin]");
    process.exit(1);
  }
  if (role !== "mod" && role !== "admin") {
    console.error(`invalid role "${role}" — must be mod or admin`);
    process.exit(1);
  }

  const { rows: existing } = await pool.query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [
    email,
  ]);

  let userId: number;
  if (existing[0]) {
    userId = existing[0].id;
    await pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [userId, role]);
    console.log(`[staff] ${email} (user #${userId}) is now ${role}`);
  } else {
    const generated = !process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const displayName = `Staff_${randomBytes(3).toString("hex")}`;

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash, display_name, email_verified_at, role)
       VALUES ($1, $2, $3, now(), $4) RETURNING id`,
      [email, passwordHash, displayName, role],
    );
    userId = rows[0]!.id;
    await pool.query(`INSERT INTO user_stats (user_id) VALUES ($1)`, [userId]);
    players.register(userId, displayName);

    console.log(`[staff] created ${email} (user #${userId}, display name ${displayName}) as ${role}`);
    if (generated) {
      console.log(`[staff] password: ${password}`);
      console.log("[staff] this is shown once — store it now.");
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
