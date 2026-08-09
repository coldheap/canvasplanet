/**
 * Streaks (ROADMAP.md Phase 6) end to end, against the real paint
 * transaction's SQL (paint/service.ts's gain_user CTE) — not just the JS
 * mirror in players/store.ts, which vitest already covers in isolation.
 *
 * Real UTC-day transitions can't be waited out in a test run, so this signs
 * up a real account (same real-email flow as accounts.mjs), paints once for
 * a real streak_days=1, then reaches directly into Postgres to rewind
 * user_stats.last_paint_date — the one column nothing else ever writes
 * backwards — before each further paint, to exercise "next day" (+1),
 * "same day twice" (unchanged) and "a gap day" (resets to 1, best_streak
 * unaffected) the same way the real calendar would, just compressed.
 *
 * Needs a real SMTP catcher — same skip-not-fail convention as accounts.mjs.
 */
import pg from "pg";
import { finish } from "./finish.mjs";

const BASE = "http://127.0.0.1:8080";
const MAILDEV = process.env.MAILDEV_URL ?? "http://127.0.0.1:1080";
const stamp = Date.now();
const EMAIL = `verify-streaks-${stamp}@example.com`;
const PASSWORD = "correcthorsebattery";
const DISPLAY_NAME = `StreakRun${stamp % 100000}`;
const X = 910000 + Math.floor(Math.random() * 200);
const Y = 910000 + Math.floor(Math.random() * 200);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);

async function post(path, body, cookie = "") {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, cookies: cookiesOf(res) };
}

const maildevUp = await fetch(`${MAILDEV}/api/email`).then((r) => r.ok).catch(() => false);
if (!maildevUp) {
  console.log(`SKIP  no maildev catcher reachable at ${MAILDEV} — run \`pnpm mail:dev\` to exercise this script`);
  finish(0, "streaks");
} else {
  const client = new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://worldcanvas:worldcanvas_dev@127.0.0.1:5544/worldcanvas",
  });
  await client.connect();

  await post("/api/auth/signup", { email: EMAIL, password: PASSWORD, displayName: DISPLAY_NAME });

  let msg = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !msg) {
    const list = await fetch(`${MAILDEV}/api/email`).then((r) => r.json());
    msg = list.find((m) => m.to?.[0]?.address === EMAIL);
    if (!msg) await sleep(200);
  }
  const linkMatch = msg && /(https?:\/\/\S*\/api\/auth\/verify\?token=\S+)/.exec(msg.text);
  check("signup + verification email arrived", Boolean(linkMatch));

  if (!linkMatch) {
    await client.end();
    finish(failures + 1, "streaks");
  } else {
    const verifyRes = await fetch(linkMatch[1], { redirect: "manual" });
    const verifyCookies = cookiesOf(verifyRes);
    const userCookie = verifyCookies.find((c) => c.startsWith("wc_user="));
    const sessCookie = verifyCookies.find((c) => c.startsWith("wc_sess="));
    const jar = [sessCookie, userCookie].filter(Boolean).join("; ");
    check("verify-click logged the account in", Boolean(userCookie && sessCookie));

    // ---- paint 1: a first-ever paint starts a streak at 1 ----------------------
    const p1 = await post("/api/paint", { x: X, y: Y, color: 3 }, jar);
    check("first paint succeeds", p1.status === 200, JSON.stringify(p1.body));

    let me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: jar } }).then((r) => r.json());
    check("streak starts at 1, best_streak 1", me.streakDays === 1 && me.bestStreak === 1, JSON.stringify(me));

    const { rows: idRows } = await client.query(`SELECT id FROM users WHERE email = $1`, [EMAIL]);
    // node-postgres returns BIGINT as a string to avoid precision loss —
    // the wire tuple's userId is a JS number, so this must be one too.
    const userId = Number(idRows[0].id);

    // ---- same UTC day again: repainting must not move the streak ---------------
    const p2 = await post("/api/paint", { x: X, y: Y + 1, color: 4 }, jar);
    check("second same-day paint succeeds", p2.status === 200, JSON.stringify(p2.body));
    me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: jar } }).then((r) => r.json());
    check("a second paint on the same UTC day leaves the streak at 1", me.streakDays === 1, JSON.stringify(me));

    // ---- rewind to "yesterday" and paint again: the real SQL CTE must see it ---
    // as the very next day and increment, not treat it as a gap.
    await client.query(`UPDATE user_stats SET last_paint_date = last_paint_date - 1 WHERE user_id = $1`, [userId]);
    const p3 = await post("/api/paint", { x: X, y: Y + 2, color: 5 }, jar);
    check("paint after rewinding to yesterday succeeds", p3.status === 200, JSON.stringify(p3.body));
    me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: jar } }).then((r) => r.json());
    check(
      "the real paint transaction's gain_user CTE increments the streak to 2 and raises best_streak",
      me.streakDays === 2 && me.bestStreak === 2,
      JSON.stringify(me),
    );

    // ---- rewind by 3 days (a gap): the streak resets, but the record stands ----
    await client.query(`UPDATE user_stats SET last_paint_date = last_paint_date - 3 WHERE user_id = $1`, [userId]);
    const p4 = await post("/api/paint", { x: X, y: Y + 3, color: 6 }, jar);
    check("paint after a 3-day gap succeeds", p4.status === 200, JSON.stringify(p4.body));
    me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: jar } }).then((r) => r.json());
    check(
      "a gap resets the streak to 1 without touching the historical best_streak",
      me.streakDays === 1 && me.bestStreak === 2,
      JSON.stringify(me),
    );

    // ---- the player leaderboard tuple carries the same current streak ----------
    const boot = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: jar } }).then((r) => r.json());
    const row = boot.playerLeaderboard.find((r) => r[0] === userId);
    check(
      "playerLeaderboard's [userId, name, cumulative, held, streakDays] tuple matches",
      Boolean(row) && row[4] === 1,
      JSON.stringify(row),
    );

    await client.end();
    finish(failures, "streaks");
  }
}
