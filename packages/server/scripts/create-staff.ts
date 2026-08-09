/**
 * Mint a staff account.
 *
 *   pnpm staff:create -- --user alice --role admin
 *
 * The password is read from BOOTSTRAP_ADMIN_PASSWORD or generated and
 * printed once. It is hashed with argon2id before it touches the database;
 * there is no path that stores or logs a plaintext password.
 *
 * Roles: `mod` (revert, ban, inspect, unlimited pixels) and `admin`
 * (everything, plus regions, freeze, stamp, staff management).
 */

import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { pool } from "../src/db/pool.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const username = arg("user") ?? process.env.BOOTSTRAP_ADMIN_USER;
  const role = (arg("role") ?? "admin") as "mod" | "admin";

  if (!username) {
    console.error("usage: pnpm staff:create -- --user <name> [--role mod|admin]");
    process.exit(1);
  }
  if (role !== "mod" && role !== "admin") {
    console.error(`invalid role "${role}" — must be mod or admin`);
    process.exit(1);
  }

  const generated = !process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO staff (username, password_hash, role) VALUES ($1,$2,$3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
    [username, hash, role],
  );

  console.log(`[staff] ${username} (${role}) ready`);
  if (generated) {
    console.log(`[staff] password: ${password}`);
    console.log("[staff] this is shown once — store it now.");
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
