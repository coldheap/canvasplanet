/**
 * Self-service account deletion (routes/auth.ts's DELETE /api/auth/me) end
 * to end: the confirmation check, the erasure itself, and — the part worth
 * proving rather than assuming — what deletion deliberately leaves behind.
 *
 * Deletion here is erasure-by-anonymisation, not a row delete: a hard DELETE
 * is impossible while chat_messages, chat_reports and audit_log hold NOT
 * NULL references to users(id) (see migrations/0024_user_deletion.sql). That
 * makes the negative assertions the important ones. If someone later
 * "simplifies" this into a DELETE, the pixel-survives and session-still-
 * paints checks below are what fail.
 *
 * Same shape and dependencies as accounts.mjs — needs a real SMTP catcher to
 * read the verification link from (`pnpm mail:dev`), and skips rather than
 * fails without one.
 */
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { finish } from "./finish.mjs";

// The HTTP surface deliberately never exposes pixel attribution — /api/pixel
// omits it on purpose ("Session and IP are deliberately NOT here", see
// routes/explore.ts) — so the erasure assertions below read the database
// directly. That is the right level for them anyway: the promise this script
// is checking is a promise about what is stored, not about what is served.
loadDotenv({ path: new URL("../../../.env", import.meta.url).pathname.slice(1), quiet: true });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const BASE = "http://127.0.0.1:8080";
const MAILDEV = process.env.MAILDEV_URL ?? "http://127.0.0.1:1080";
const stamp = Date.now();
const EMAIL = `verify-deletion-${stamp}@example.com`;
const PASSWORD = "correcthorsebattery";
const DISPLAY_NAME = `VerifyDel${stamp % 100000}`;
const X = 900000 + Math.floor(Math.random() * 500);
const Y = 900000 + Math.floor(Math.random() * 500);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);

async function call(method, path, body, cookie = "") {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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
  finish(0, "deletion");
} else {
  // ---- an account with something to lose ------------------------------------
  const signup = await call("POST", "/api/auth/signup", {
    email: EMAIL,
    password: PASSWORD,
    displayName: DISPLAY_NAME,
  });
  check("signup succeeds", signup.status === 200 && signup.body.ok === true, JSON.stringify(signup.body));

  let msg = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !msg) {
    const list = await fetch(`${MAILDEV}/api/email`).then((r) => r.json());
    msg = list.find((m) => m.to?.[0]?.address === EMAIL);
    if (!msg) await sleep(200);
  }
  const linkMatch = msg && /(https?:\/\/\S*\/api\/auth\/verify\?token=\S+)/.exec(msg.text);
  check("a verification link arrived", Boolean(linkMatch));

  let userCookie = "";
  let sessCookie = "";
  if (linkMatch) {
    const verified = await fetch(linkMatch[1], { redirect: "manual" });
    const cookies = cookiesOf(verified);
    userCookie = cookies.find((c) => c.startsWith("cp_user=")) ?? "";
    sessCookie = cookies.find((c) => c.startsWith("cp_sess=")) ?? "";
    check("verifying signs the account in", Boolean(userCookie) && Boolean(sessCookie));
  }
  const both = [sessCookie, userCookie].filter(Boolean).join("; ");

  // Paint one pixel, so there is real attribution to erase.
  const paint = await call("POST", "/api/paint", { x: X, y: Y, color: 3 }, both);
  const painted = paint.status === 200 && paint.body.ok === true;
  check("the account painted a pixel", painted, JSON.stringify(paint.body).slice(0, 120));

  const before = await call("GET", "/api/auth/me", null, both);
  check(
    "the pixel is attributed to the account",
    before.status === 200 && before.body.cumulative >= 1,
    `cumulative=${before.body?.cumulative}`,
  );
  const userId = before.body?.id;
  check("the account has an id to check the erasure against", Number.isInteger(userId), String(userId));

  // ---- the confirmation actually gates it -----------------------------------
  const noConfirm = await call("DELETE", "/api/auth/me", {}, both);
  check("deletion without a confirmation is refused", noConfirm.status === 400, `HTTP ${noConfirm.status}`);

  const wrongConfirm = await call("DELETE", "/api/auth/me", { confirm: "not my name" }, both);
  check("deletion with the wrong name is refused", wrongConfirm.status === 400, `HTTP ${wrongConfirm.status}`);

  const stillThere = await call("GET", "/api/auth/me", null, both);
  check("a refused deletion left the account intact", stillThere.status === 200, `HTTP ${stillThere.status}`);

  const anon = await call("DELETE", "/api/auth/me", { confirm: DISPLAY_NAME }, "");
  check("deletion without a session is refused", anon.status === 401, `HTTP ${anon.status}`);

  // Case-insensitive, because display_name is CITEXT and the account would
  // already answer to this spelling at login.
  const wrongCase = DISPLAY_NAME.toUpperCase();

  // ---- the real thing --------------------------------------------------------
  const gone = await call("DELETE", "/api/auth/me", { confirm: wrongCase }, both);
  check(
    "deletion succeeds with the display name typed back (case-insensitively)",
    gone.status === 200 && gone.body.ok === true,
    JSON.stringify(gone.body),
  );

  const after = await call("GET", "/api/auth/me", null, both);
  check("the account no longer authenticates", after.status === 404, `HTTP ${after.status}`);

  const relogin = await call("POST", "/api/auth/login", { identifier: EMAIL, password: PASSWORD });
  check("the old email and password no longer log in", relogin.status !== 200, `HTTP ${relogin.status}`);

  // The email is freed, which is the observable proof it was really cleared
  // rather than just flagged — `users.email` is UNIQUE.
  const reuse = await call("POST", "/api/auth/signup", {
    email: EMAIL,
    password: PASSWORD,
    displayName: `${DISPLAY_NAME}B`,
  });
  check("the email address is free to sign up again", reuse.status === 200, `HTTP ${reuse.status}`);

  // ---- the row itself was scrubbed, not just flagged --------------------------
  const row = await one(
    `SELECT email, password_hash, discord_id, display_name, email_verified_at,
            disabled_at, deleted_at
       FROM users WHERE id = $1`,
    [userId],
  );
  check("the user row still exists (chat and audit_log reference it)", Boolean(row));
  check("email is cleared", row?.email === null, String(row?.email));
  check("password hash is cleared", row?.password_hash === null);
  check("discord id is cleared", row?.discord_id === null);
  check(
    "display name is replaced with a placeholder",
    row?.display_name === `Deleted player #${userId}`,
    row?.display_name,
  );
  check("deleted_at and disabled_at are both stamped", Boolean(row?.deleted_at) && Boolean(row?.disabled_at));

  for (const [table, label] of [
    ["user_avatars", "the profile picture is"],
    ["user_sessions", "sign-in sessions are"],
    ["email_verifications", "verification tokens are"],
    ["password_resets", "reset tokens are"],
  ]) {
    const { count } = await one(`SELECT count(*)::int AS count FROM ${table} WHERE user_id = $1`, [userId]);
    check(`${label} deleted outright`, count === 0, `${count} row(s) left`);
  }

  const linked = await one(`SELECT count(*)::int AS count FROM sessions WHERE user_id = $1`, [userId]);
  check("no browser session is still linked to the account", linked.count === 0, `${linked.count} linked`);

  // ---- what deletion deliberately does NOT do --------------------------------
  const pixel = await call("GET", `/api/pixel/${X}/${Y}`, null, "");
  check(
    "the painted pixel is still on the canvas",
    pixel.status === 200 && pixel.body.color === 3,
    `status=${pixel.status} color=${pixel.body?.color}`,
  );

  const attributed = await one(`SELECT user_id FROM pixels WHERE x = $1 AND y = $2`, [X, Y]);
  check("...but is no longer attributed to the deleted account", attributed?.user_id === null, String(attributed?.user_id));

  const events = await one(`SELECT count(*)::int AS count FROM pixel_events WHERE user_id = $1`, [userId]);
  check("canvas history is detached from the account too", events.count === 0, `${events.count} event(s) left`);

  // cumulative and held are BIGINT, which node-postgres hands back as strings.
  const stats = await one(`SELECT cumulative, held, streak_days FROM user_stats WHERE user_id = $1`, [userId]);
  check(
    "leaderboard stats are zeroed, dropping the account off the board",
    !stats || [stats.cumulative, stats.held, stats.streak_days].every((v) => Number(v) === 0),
    JSON.stringify(stats),
  );

  // Deleting an account is not a ban: the browser keeps its charge bank.
  const stillPaints = await call("POST", "/api/paint", { x: X + 1, y: Y, color: 5 }, sessCookie);
  check(
    "the browser session can still paint anonymously afterwards",
    stillPaints.status === 200 && stillPaints.body.ok === true,
    JSON.stringify(stillPaints.body).slice(0, 120),
  );

  await db.end();
  finish(failures, "deletion");
}
