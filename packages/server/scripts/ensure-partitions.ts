/**
 * Keep `pixel_events` partitioned by month, ahead of time.
 *
 *   pnpm db:partitions            # ensure this month .. +3
 *   pnpm db:partitions -- --ahead 6
 *
 * Run monthly from cron. A missing partition is not a silent degradation:
 * rows land in the DEFAULT partition, which grows without bound and drags
 * every revert and timelapse query with it. The canvas never resets, so this
 * table only ever grows — partitioning is the thing that keeps it usable in
 * year two.
 *
 * Creating a partition for a month that already has rows in DEFAULT is the
 * awkward case: Postgres refuses, because those rows would belong in the new
 * partition. The fix is to detach DEFAULT, create the partition, move the
 * rows through the parent, and re-attach — all in one transaction.
 */

import { pool, tx } from "../src/db/pool.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Partition bounds cannot be bind parameters — `FOR VALUES FROM ($1)` is a
 * protocol error, because DDL is not planned like DML. They have to be
 * inlined, so every value is shape-checked first. Both are generated from a
 * Date here rather than taken from input, but an assertion at the point of
 * interpolation is what keeps that true if this is ever refactored.
 */
function literal(ts: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+00$/.test(ts)) {
    throw new Error(`refusing to inline malformed timestamp: ${ts}`);
  }
  return `'${ts}'`;
}

function partitionName(name: string): string {
  if (!/^pixel_events_\d{4}_\d{2}$/.test(name)) {
    throw new Error(`refusing to inline malformed partition name: ${name}`);
  }
  return name;
}

/** UTC month boundaries — partition ranges must not drift with server TZ. */
function monthRange(offset: number): { name: string; from: string; to: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const name = `pixel_events_${start.getUTCFullYear()}_${pad(start.getUTCMonth() + 1)}`;
  const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01 00:00:00+00`;
  return { name, from: fmt(start), to: fmt(end) };
}

async function partitionExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class WHERE relname = $1`,
    [name],
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function rowsInDefaultFor(from: string, to: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pixel_events_default
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
    [from, to],
  );
  return rows[0]?.n ?? 0;
}

async function main(): Promise<void> {
  const ahead = arg("ahead", 3);
  // Start one month back so a run after a quiet period still rescues rows
  // that piled up in DEFAULT.
  const offsets = Array.from({ length: ahead + 2 }, (_, i) => i - 1);

  let created = 0;
  let moved = 0;

  for (const offset of offsets) {
    const { name, from, to } = monthRange(offset);
    if (await partitionExists(name)) continue;

    const stranded = await rowsInDefaultFor(from, to);

    if (stranded === 0) {
      // The easy path: no conflicting rows, so a plain CREATE works.
      await pool.query(
        `CREATE TABLE ${partitionName(name)} PARTITION OF pixel_events
           FOR VALUES FROM (${literal(from)}) TO (${literal(to)})`,
      );
      console.log(`[partitions] created ${name}`);
      created++;
      continue;
    }

    // Rows already exist in DEFAULT for this month. Detach, create, move,
    // re-attach — atomically, so a crash mid-way cannot leave the table
    // without a default partition and start rejecting inserts.
    console.log(`[partitions] ${name}: ${stranded.toLocaleString()} rows stranded in DEFAULT, migrating`);
    await tx(async (c) => {
      await c.query(`ALTER TABLE pixel_events DETACH PARTITION pixel_events_default`);
      await c.query(
        `CREATE TABLE ${partitionName(name)} PARTITION OF pixel_events
           FOR VALUES FROM (${literal(from)}) TO (${literal(to)})`,
      );
      // Route through the parent so the rows land in the right partition.
      await c.query(
        `WITH moved AS (
           DELETE FROM pixel_events_default
            WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
            RETURNING *
         )
         INSERT INTO pixel_events SELECT * FROM moved`,
        [from, to],
      );
      await c.query(`ALTER TABLE pixel_events ATTACH PARTITION pixel_events_default DEFAULT`);
    });
    console.log(`[partitions] created ${name} and moved ${stranded.toLocaleString()} rows`);
    created++;
    moved += stranded;
  }

  // Exact, not estimated: this number decides whether to warn.
  const { rows: leftovers } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pixel_events_default`,
  );
  const remaining = leftovers[0]?.n ?? 0;

  // ANALYZE first: the planner statistics this report reads are only
  // refreshed by autovacuum, so straight after moving rows they still show
  // the old distribution — which reads as "the migration did nothing".
  await pool.query(`ANALYZE pixel_events`);

  const { rows: parts } = await pool.query<{ name: string; rows: number }>(
    `SELECT c.relname AS name, COALESCE(s.n_live_tup, 0)::int AS rows
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE i.inhparent = 'pixel_events'::regclass
      ORDER BY c.relname`,
  );

  console.log(`\n[partitions] ${created} created, ${moved.toLocaleString()} rows migrated`);
  for (const p of parts) console.log(`  ${p.name.padEnd(28)} ~${p.rows.toLocaleString()} rows`);
  if (remaining > 0) {
    // Not an error — rows dated outside the covered window legitimately
    // live here — but worth surfacing, since a growing default means the
    // cron has stopped running.
    console.warn(`\n[partitions] WARNING: ${remaining.toLocaleString()} rows still in DEFAULT.`);
    console.warn(`[partitions] Widen --ahead, or check this script is running monthly.`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
