/**
 * Alliances / teams (ROADMAP.md §4.1) end to end: create, join, leave, the
 * paint-transaction stats update, and the live "alb" broadcast.
 *
 * Admin moderation (disable) is gated on VERIFY_ADMIN_PASSWORD, same as
 * admin.mjs, and skipped without it.
 */
import { finish } from "./finish.mjs";
import WebSocket from "ws";

const BASE = "http://127.0.0.1:8080";
const COLOR = 21;
const NAME = `Verify Alliance ${Date.now()}`;
// Fresh pixels each run so cost/ownership assertions stay stable.
const X = 800000 + Math.floor(Math.random() * 200);
const Y = 800000 + Math.floor(Math.random() * 200);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session() {
  const boot = await fetch(`${BASE}/api/bootstrap`);
  const cookie = cookiesOf(boot).join("; ");
  return { cookie, boot: await boot.json() };
}
function client(cookie) {
  const call = async (path, method = "GET", body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      // Content-Type only when there is a body: an empty one paired with a
      // JSON content-type is its own 400 (FST_ERR_CTP_EMPTY_JSON_BODY).
      headers: body ? { "Content-Type": "application/json", cookie } : { cookie },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
  return call;
}

const a = await session();
const b = await session();
const apiA = client(a.cookie);
const apiB = client(b.cookie);

check("fresh session has no alliance", a.boot.yourAllianceId === null, JSON.stringify(a.boot.yourAllianceId));

// ---- validation -------------------------------------------------------------
const badName = await apiA("/api/alliances", "POST", { name: "ab", color: 0 });
check("rejects a too-short name", badName.status === 400, `HTTP ${badName.status}`);
const badColor = await apiA("/api/alliances", "POST", { name: NAME, color: 999 });
check("rejects an invalid palette index", badColor.status === 400, `HTTP ${badColor.status}`);

// ---- create -----------------------------------------------------------------
const created = await apiA("/api/alliances", "POST", { name: NAME, color: COLOR });
check("create succeeds", created.status === 200 && typeof created.body.id === "number", JSON.stringify(created.body));
const allianceId = created.body.id;

const dupe = await apiA("/api/alliances", "POST", { name: NAME, color: 0 });
check("rejects a duplicate name", dupe.status === 409, `HTTP ${dupe.status}`);

const bootAfterCreate = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: a.cookie } })).json();
check(
  "creating an alliance joins it",
  bootAfterCreate.yourAllianceId === allianceId,
  JSON.stringify(bootAfterCreate.yourAllianceId),
);
check(
  "the new alliance appears in the bootstrap list",
  bootAfterCreate.alliances.some((al) => al.id === allianceId),
);

// ---- a second session joins it -----------------------------------------------
// {} rather than no body at all — same reason the real web client
// (api.ts's post()) always sends one: an empty body with a JSON
// content-type is itself a 400 (FST_ERR_CTP_EMPTY_JSON_BODY).
const join = await apiB(`/api/alliances/${allianceId}/join`, "POST", {});
check("second session joins", join.status === 200 && join.body.allianceId === allianceId, JSON.stringify(join.body));

// Rejoining/leaving immediately is the abuse case the cooldown exists for.
const tooSoon = await apiB("/api/alliances/leave", "POST", {});
check("leaving immediately after joining is refused", tooSoon.status === 429, `HTTP ${tooSoon.status}`);

const missing = await apiB(`/api/alliances/999999/join`, "POST", {});
check("joining a nonexistent alliance 404s", missing.status === 404, `HTTP ${missing.status}`);

// ---- live broadcast: does a member's paint reach the alliance leaderboard ---
const ws = new WebSocket(`ws://127.0.0.1:8080/ws`, { headers: { cookie: a.cookie } });
const frames = [];
ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

const paint = await fetch(`${BASE}/api/paint`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: a.cookie },
  body: JSON.stringify({ x: X, y: Y, color: COLOR }),
});
check("member paint accepted", paint.status === 200, `HTTP ${paint.status}`);

let alb = null;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !alb) {
  alb = frames.find((f) => f.t === "alb" && f.rows.some((r) => r[0] === allianceId));
  if (!alb) await sleep(50);
}
check("alliance leaderboard broadcast reflects the paint", Boolean(alb), JSON.stringify(alb));
if (alb) {
  const row = alb.rows.find((r) => r[0] === allianceId);
  check("cumulative and held both moved", row[1] >= 1 && row[2] >= 1, JSON.stringify(row));
}
ws.close();

// ---- detail + list -----------------------------------------------------------
const detail = await apiA(`/api/alliances/${allianceId}`);
check(
  "detail shows both members and the paint",
  detail.status === 200 && detail.body.members === 2 && detail.body.cumulative >= 1,
  JSON.stringify(detail.body),
);

const list = await apiA("/api/alliances");
check(
  "list includes the new alliance and its stats row",
  list.body.alliances.some((al) => al.id === allianceId) && list.body.rows.some((r) => r[0] === allianceId),
);

// ---- leave --------------------------------------------------------------------
const left = await apiA("/api/alliances/leave", "POST", {});
check("leave is refused inside the cooldown right after creating", left.status === 429, `HTTP ${left.status}`);

// ---- authorisation for admin moderation --------------------------------------
const noAuth = await fetch(`${BASE}/api/admin/alliances`);
check("admin alliance list is hidden without a staff role", noAuth.status === 404, `HTTP ${noAuth.status}`);

// ---- admin disable (optional, staff-gated like admin.mjs) -------------------
const ADMIN_EMAIL = process.env.VERIFY_ADMIN_EMAIL ?? "verify@example.com";
const ADMIN_PASS = process.env.VERIFY_ADMIN_PASSWORD;
if (!ADMIN_PASS) {
  console.log("SKIP  VERIFY_ADMIN_PASSWORD not set — admin disable check skipped");
} else {
  const staffBoot = await fetch(`${BASE}/api/bootstrap`);
  let jar = cookiesOf(staffBoot);
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar.join("; ") },
    body: JSON.stringify({ identifier: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  if (login.status === 200) {
    jar = [...jar, ...cookiesOf(login)];
    const apiStaff = client(jar.join("; "));

    const disable = await apiStaff(`/api/admin/alliances/${allianceId}/disable`, "POST", { disabled: true });
    check("admin disables the alliance", disable.status === 200, JSON.stringify(disable.body));

    const afterDisable = await apiA(`/api/alliances/${allianceId}`);
    check("a disabled alliance's detail page 404s", afterDisable.status === 404, `HTTP ${afterDisable.status}`);

    const bootAfterDisable = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: a.cookie } })).json();
    check(
      "disabling evicts its members",
      bootAfterDisable.yourAllianceId === null,
      JSON.stringify(bootAfterDisable.yourAllianceId),
    );

    // Re-enable so a repeat run of this script does not accumulate disabled
    // rows forever, and so the unique name constraint stays free for reuse.
    await apiStaff(`/api/admin/alliances/${allianceId}/disable`, "POST", { disabled: false });
  } else {
    check("staff login for admin disable check", false, `HTTP ${login.status}`);
  }
}

finish(failures, "alliances");
