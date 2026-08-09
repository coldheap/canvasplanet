/**
 * Corruption events (ROADMAP.md Phase 7) end to end, against a real running
 * server and a real Postgres — not just the pure ActiveEventState arithmetic
 * vitest already covers in isolation.
 *
 * The real cadence is ~90 minutes to start and 10 minutes to run, which
 * cannot be waited out in a test run. This script instead requires the
 * server it targets to be started with EVENT_INTERVAL_MS/EVENT_DURATION_MS
 * set low (see env.ts) — that's also why this is NOT in run.mjs's default
 * list, unlike every other script here: it needs a differently-configured
 * server, not just a running one.
 *
 * Point it at that server with VERIFY_BASE (defaults to :8080, so it still
 * works if you deliberately boot your dev server with the env override):
 *
 *   EVENT_INTERVAL_MS=3000 EVENT_DURATION_MS=8000 PORT=8099 pnpm dev &
 *   VERIFY_BASE=http://127.0.0.1:8099 node verify/events.mjs
 */
import pg from "pg";
import { finish } from "./finish.mjs";

const BASE = process.env.VERIFY_BASE ?? "http://127.0.0.1:8080";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://worldcanvas:worldcanvas_dev@127.0.0.1:5544/worldcanvas",
});
await client.connect();

// ---- a fresh session to defend with ----------------------------------------
const bootRes = await fetch(`${BASE}/api/bootstrap`);
const jar = cookiesOf(bootRes).join("; ");
const boot = await bootRes.json();
check("bootstrap carries an event field (null when nothing running yet)", "event" in boot, JSON.stringify(boot.event));

// ---- wait for an event to start --------------------------------------------
console.log("  waiting for a corruption event to start (needs EVENT_INTERVAL_MS set low)...");
let row = null;
const startDeadline = Date.now() + 20_000;
while (Date.now() < startDeadline && !row) {
  const { rows } = await client.query(
    `SELECT id, x0, y0, x1, y1, bot_color, started_at, ends_at
       FROM corruption_events WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 1`,
  );
  row = rows[0] ?? null;
  if (!row) await sleep(500);
}
check("a corruption event started", Boolean(row), row ? `id=${row.id}` : "timed out after 20s");

if (!row) {
  await client.end();
  finish(failures + 1, "events");
} else {
  const zone = { x0: row.x0, y0: row.y0, x1: row.x1, y1: row.y1 };
  const botColor = row.bot_color;

  // ---- the WS/bootstrap-visible shape matches the DB row ------------------
  const midBoot = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: jar } }).then((r) => r.json());
  check(
    "bootstrap's event.bbox matches the started event",
    Boolean(
      midBoot.event &&
        midBoot.event.id === row.id &&
        midBoot.event.bbox.x0 === zone.x0 &&
        midBoot.event.bbox.x1 === zone.x1,
    ),
    JSON.stringify(midBoot.event),
  );

  // ---- defend: paint one zone pixel a non-bot colour -----------------------
  const dx = zone.x0 + Math.floor((zone.x1 - zone.x0) / 2);
  const dy = zone.y0 + Math.floor((zone.y1 - zone.y0) / 2);
  const defendColor = botColor === 7 ? 8 : 7;
  const paintRes = await fetch(`${BASE}/api/paint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar },
    body: JSON.stringify({ x: dx, y: dy, color: defendColor }),
  });
  const paintBody = await paintRes.json();
  check("defending paint inside the zone succeeds", paintRes.status === 200, JSON.stringify(paintBody));

  // Give the engine a tick to fold the defending paint into its live state.
  await sleep(1200);
  const afterDefend = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: jar } }).then((r) => r.json());
  check(
    "the defending paint is credited before the event ends",
    Boolean(afterDefend.event && afterDefend.event.defenders >= 1),
    JSON.stringify(afterDefend.event),
  );

  // ---- wait for resolution ---------------------------------------------------
  console.log("  waiting for the event to resolve...");
  let resolved = null;
  const endDeadline = Date.now() + 30_000;
  while (Date.now() < endDeadline && !resolved) {
    const { rows } = await client.query(
      `SELECT resolved_at, result, corruption_pct, defenders FROM corruption_events WHERE id = $1`,
      [row.id],
    );
    if (rows[0]?.resolved_at) resolved = rows[0];
    else await sleep(500);
  }
  check("the event resolved", Boolean(resolved), resolved ? JSON.stringify(resolved) : "timed out after 30s");

  if (resolved) {
    check(
      "one lightly-defended small zone resolves as 'defended'",
      resolved.result === "defended",
      JSON.stringify(resolved),
    );
    check("the resolved row credits our one defending session", resolved.defenders === 1, `defenders=${resolved.defenders}`);

    // ---- zero permanent trace: the zone is back to its pre-event state -------
    const { rows: leftover } = await client.query(
      `SELECT count(*)::int AS n FROM pixels WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4`,
      [zone.x0, zone.x1, zone.y0, zone.y1],
    );
    check(
      "the whole zone reverted — nothing painted there survives (it was empty before the event)",
      leftover[0].n === 0,
      `${leftover[0].n} pixels remain`,
    );

    const pixelInfo = await fetch(`${BASE}/api/pixel/${dx}/${dy}`).then((r) => r.json());
    check("the defended pixel specifically is back to unpainted", pixelInfo.color === null, JSON.stringify(pixelInfo));

    // ---- the WS push cleared client-side state --------------------------------
    const afterBoot = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: jar } }).then((r) => r.json());
    check("bootstrap.event is null again after resolution", afterBoot.event === null, JSON.stringify(afterBoot.event));

    // ---- the reward: a temporary charge-rate bonus for the defender -----------
    // regenMs is the real, end-to-end signal a client actually sees — it only
    // moves if effectiveRegenMs() read a live event_bonus_until off the
    // session row, so this alone proves the whole plumbing (resolveEvent's
    // UPDATE -> session.eventBonusUntil -> bootstrap's regenMs).
    check(
      "the defender's bootstrap now reports a faster regenMs (the charge-rate reward)",
      afterBoot.regenMs < boot.regenMs,
      `before=${boot.regenMs}ms after=${afterBoot.regenMs}ms`,
    );
  }

  await client.end();
  finish(failures, "events");
}
