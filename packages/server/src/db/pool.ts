import pg from "pg";
import { env } from "../env.js";

// BIGINT (oid 20) arrives as a string by default so JS can't silently lose
// precision. Every bigint we read (ids, counters) is well under 2^53, and the
// leaderboard maths needs numbers, so parse it.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  // A paint must never hang behind a lock; fail fast and let the client retry.
  statement_timeout: 5_000,
});

pool.on("error", (err) => {
  console.error("[db] idle client error", err);
});

export type Client = pg.PoolClient;

/**
 * Run a function inside a transaction, rolling back on throw.
 * The paint path relies on this for its FOR UPDATE serialisation.
 */
export async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
