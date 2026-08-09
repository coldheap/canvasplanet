/**
 * Admin + explore endpoints against a running server.
 *
 * Exercises the paths that only staff can reach (stamp, revert, staff
 * management, freeze) plus timelapse and templates. Requires a staff account
 * — create one with `pnpm staff:create -- --user verify --role admin` and
 * pass the password as VERIFY_ADMIN_PASSWORD.
 */
import { finish } from "./finish.mjs";
const BASE = "http://127.0.0.1:8080";
const USER = process.env.VERIFY_ADMIN_USER ?? "verify";
const PASS = process.env.VERIFY_ADMIN_PASSWORD;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);

if (!PASS) {
  console.log("SKIP  VERIFY_ADMIN_PASSWORD not set — admin checks skipped");
  process.exit(0);
}

// ---- sign in --------------------------------------------------------------
const anon = await fetch(`${BASE}/api/bootstrap`);
let jar = cookiesOf(anon);

const login = await fetch(`${BASE}/api/staff/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: jar.join("; ") },
  body: JSON.stringify({ username: USER, password: PASS }),
});
check("staff login", login.status === 200, `HTTP ${login.status}`);
if (login.status !== 200) process.exit(1);
jar = [...jar, ...cookiesOf(login)];
const cookie = jar.join("; ");

const api = async (path, method = "GET", body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
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

// bootstrap should now report the staff session, which is what makes the
// Admin tab appear in the UI at all.
const boot = await (await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } })).json();
check("bootstrap reports staff session", boot.staff?.role === "admin", JSON.stringify(boot.staff));

// ---- stamp ----------------------------------------------------------------
// A 4x4 block well away from anything else, one pixel left transparent.
const SX = 900000 + Math.floor(Math.random() * 1000);
const SY = 900000;
const data = Array.from({ length: 16 }, (_, i) => (i === 5 ? 255 : 20));

// Everything from here belongs to this run only. pixel_events is
// append-only and never cleared, so a bbox that happens to overlap an
// earlier run would otherwise pick up its events too.
const runStart = Date.now() - 1000;

const preview = await api("/api/admin/stamp", "POST", { x: SX, y: SY, w: 4, h: 4, data, preview: true });
check("stamp preview counts pixels", preview.body.pixels === 15, JSON.stringify(preview.body));
check("stamp preview does not write", preview.body.batchId === null);

const applied = await api("/api/admin/stamp", "POST", { x: SX, y: SY, w: 4, h: 4, data });
check("stamp applies", applied.status === 200 && applied.body.pixels === 15, JSON.stringify(applied.body));
check("stamp returns one batch id", typeof applied.body.batchId === "string");

const stamped = await (await fetch(`${BASE}/api/pixel/${SX}/${SY}`)).json();
check("stamped pixel is on the canvas", stamped.color === 20, `color=${stamped.color}`);
const skipped = await (await fetch(`${BASE}/api/pixel/${SX + 1}/${SY + 1}`)).json();
check("transparent pixel was skipped", skipped.color === null, `color=${skipped.color}`);

// ---- stamp validation -----------------------------------------------------
const badLen = await api("/api/admin/stamp", "POST", { x: SX, y: SY, w: 4, h: 4, data: [1, 2] });
check("stamp rejects wrong data length", badLen.status === 400, `HTTP ${badLen.status}`);
const tooBig = await api("/api/admin/stamp", "POST", { x: SX, y: SY, w: 999, h: 1, data: [] });
check("stamp rejects oversized area", tooBig.status === 422, `HTTP ${tooBig.status}`);

// Protected regions must hold even against an admin stamp.
const onLandmark = await api("/api/admin/stamp", "POST", {
  x: 524288, y: 524288, w: 2, h: 2, data: [4, 4, 4, 4], preview: true,
});
check(
  "stamp will not overwrite a protected region",
  onLandmark.body.pixels === 0 && onLandmark.body.skippedProtected === 4,
  JSON.stringify(onLandmark.body),
);

// ---- revert ---------------------------------------------------------------
const rPrev = await api("/api/admin/revert", "POST", {
  bbox: { x0: SX, y0: SY, x1: SX + 3, y1: SY + 3 },
  since: runStart,
  preview: true,
});
check("revert preview finds the stamp", rPrev.body.affected === 15, JSON.stringify(rPrev.body));

const rApply = await api("/api/admin/revert", "POST", {
  bbox: { x0: SX, y0: SY, x1: SX + 3, y1: SY + 3 },
  since: runStart,
});
check("revert applies", rApply.status === 200 && rApply.body.affected === 15);
const reverted = await (await fetch(`${BASE}/api/pixel/${SX}/${SY}`)).json();
check("stamped pixel is gone after revert", reverted.color === null, `color=${reverted.color}`);

// ---- staff management -----------------------------------------------------
const weak = await api("/api/admin/staff", "POST", { username: "tmpuser", password: "short", role: "mod" });
check("rejects a weak staff password", weak.status === 400, `HTTP ${weak.status}`);
const badRole = await api("/api/admin/staff", "POST", {
  username: "tmpuser", password: "a-long-enough-password", role: "root",
});
check("rejects an unknown role", badRole.status === 400, `HTTP ${badRole.status}`);

const me = await api(`/api/admin/staff/${boot.staff.id}/disable`, "POST", { disabled: true });
check("refuses to disable your own account", me.status === 400, `HTTP ${me.status}`);

// ---- freeze ---------------------------------------------------------------
// Wrapped so the canvas is ALWAYS unfrozen again. A failure between these two
// calls would otherwise leave painting disabled, and every later script — and
// the next run of this one — fails for a reason that has nothing to do with
// what it is testing.
// An ordinary anonymous session, used both here and by the template checks
// below. Declared outside the try so it stays in scope afterwards.
const anonBoot = await fetch(`${BASE}/api/bootstrap`);
const anonCookie = cookiesOf(anonBoot).join("; ");

try {
  await api("/api/admin/freeze", "POST", { on: true });
  const frozenPaint = await fetch(`${BASE}/api/paint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: anonCookie },
    body: JSON.stringify({ x: SX + 20, y: SY, color: 7 }),
  });
  check("freeze blocks anonymous paints", frozenPaint.status === 423, `HTTP ${frozenPaint.status}`);

  await api("/api/admin/freeze", "POST", { on: false });
  const thawed = await fetch(`${BASE}/api/paint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: anonCookie },
    body: JSON.stringify({ x: SX + 20, y: SY, color: 7 }),
  });
  check("unfreeze restores painting", thawed.status === 200, `HTTP ${thawed.status}`);
} finally {
  // Belt and braces: if anything above threw, the canvas must not be left
  // frozen for the next script or the next run.
  await api("/api/admin/freeze", "POST", { on: false });
}

// ---- audit ----------------------------------------------------------------
const audit = await api("/api/admin/audit");
const actions = new Set((audit.body ?? []).map((r) => r.action));
check("audit logged stamp, revert and freeze",
  ["stamp", "revert", "freeze"].every((a) => actions.has(a)),
  [...actions].join(","));

// ---- authorisation --------------------------------------------------------
const noAuth = await fetch(`${BASE}/api/admin/revert`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ since: Date.now() - 1000, preview: true }),
});
check("admin routes are hidden without a staff cookie", noAuth.status === 404, `HTTP ${noAuth.status}`);

// ---- timelapse ------------------------------------------------------------
const tl = await api(
  `/api/timelapse?x0=${SX}&y0=${SY}&x1=${SX + 3}&y1=${SY + 3}&from=${Date.now() - 3600_000}&to=${Date.now()}&frames=10`,
);
check("timelapse returns frames", tl.status === 200 && tl.body.frames?.length === 10, `HTTP ${tl.status}`);
const totalEvents = (tl.body.frames ?? []).reduce((n, f) => n + f.p.length, 0);
check("timelapse contains the stamp and its revert", totalEvents >= 30, `${totalEvents} events`);
const tlBig = await api(`/api/timelapse?x0=0&y0=0&x1=99999&y1=1`);
check("timelapse rejects an oversized area", tlBig.status === 422, `HTTP ${tlBig.status}`);

// ---- templates ------------------------------------------------------------
const tplData = Buffer.from(Uint8Array.from({ length: 9 }, (_, i) => (i === 0 ? 255 : 12))).toString("base64");
const tpl = await fetch(`${BASE}/api/templates`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: anonCookie },
  body: JSON.stringify({ x: SX, y: SY, w: 3, h: 3, data: tplData }),
});
const tplBody = await tpl.json();
check("template publishes", tpl.status === 200 && typeof tplBody.id === "string", JSON.stringify(tplBody));

if (tplBody.id) {
  const loaded = await (await fetch(`${BASE}/api/templates/${tplBody.id}`)).json();
  check("template round-trips", loaded.data === tplData && loaded.w === 3, JSON.stringify(loaded).slice(0, 80));
}
const badTpl = await fetch(`${BASE}/api/templates`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: anonCookie },
  body: JSON.stringify({ x: 1, y: 1, w: 3, h: 3, data: Buffer.from([99, 99]).toString("base64") }),
});
check("template rejects a bad payload", badTpl.status === 400, `HTTP ${badTpl.status}`);

finish(failures, "admin");
