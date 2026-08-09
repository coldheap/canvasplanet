/**
 * Minimal forward-only migration runner. No down migrations by design —
 * the canvas is append-only and a rollback that drops pixel data is not a
 * thing we ever want to make one command away.
 *
 *   pnpm db:migrate
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "./pool.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ name: string }>("SELECT name FROM _migrations");
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`[migrate] applying ${file}`);
    const client = await pool.connect();
    try {
      // Each file manages its own BEGIN/COMMIT so it can use statements that
      // cannot run inside a transaction block if it ever needs to.
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
    } finally {
      client.release();
    }
  }
  console.log(`[migrate] up to date (${files.length} migrations)`);
}

// `file://${process.argv[1]}` does NOT work on Windows — argv[1] is a
// backslash path and import.meta.url is a file:///C:/... URL, so the guard
// silently never fires and the script exits having done nothing.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
