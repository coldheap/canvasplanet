/**
 * Coverage for the status page, country subdivisions, and the area-report
 * queue — the moderation input path.
 *
 * These shipped without smoke coverage. Everything else in this suite exists
 * because an untested path in this project has regressed silently at least
 * once, so they get the same treatment.
 */
import { finish } from "./finish.mjs";
import { PNG } from "pngjs";

const BASE = "http://127.0.0.1:8080";
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

// ---- status ---------------------------------------------------------------
const status = await (await fetch(`${BASE}/api/status`)).json();
check("status reports overall health", status.overall === "operational", status.overall);
check("status reports database health", status.dbOk === true && status.dbLatencyMs >= 0, `${status.dbLatencyMs}ms`);
check(
  "status names its components",
  ["canvas", "realtime", "database"].every((k) => typeof status.components?.[k] === "string"),
  Object.keys(status.components ?? {}).join(","),
);
// The point of a status page is that it is reachable without credentials.
check("status needs no authentication", typeof status.uptimeSeconds === "number");

const history = await (await fetch(`${BASE}/api/status/history`)).json();
check("status history returns a daily series", Array.isArray(history.history), `${history.history?.length} days`);
check(
  "history covers the requested window",
  history.history?.length === history.days,
  `${history.history?.length} vs days=${history.days}`,
);
// Days before the server ever ran must say "nodata" rather than claiming an
// outage — an uptime page that invents downtime is worse than none.
const empty = history.history?.[0];
check("days with no samples report nodata", empty?.overall === "nodata" && empty?.uptimeRatio === null, empty?.overall);

// NOT "today has samples". Buckets are keyed by UTC date and the recorder
// ticks every 5 minutes, so today's bucket is legitimately empty for the
// first few minutes after UTC midnight and after any restart — an assertion
// on it fails every night for reasons that have nothing to do with the code.
// What actually matters is that the recorder has ever produced anything.
const recorded = history.history?.filter((d) => d.samples > 0) ?? [];
check("the recorder has produced samples", recorded.length > 0, `${recorded.length} day(s) with data`);
check(
  "recorded days carry an uptime ratio",
  recorded.every((d) => typeof d.uptimeRatio === "number" && d.uptimeRatio >= 0 && d.uptimeRatio <= 1),
);

const short = await (await fetch(`${BASE}/api/status/history?days=7`)).json();
check("the window is caller-controlled", short.history?.length === 7, `${short.history?.length}`);

// ---- country subdivisions -------------------------------------------------
// Pick the country with the most held pixels, so this does not depend on a
// particular country having been painted.
const board = await (await fetch(`${BASE}/api/leaderboard`)).json();
const boot = await fetch(`${BASE}/api/bootstrap`);
const cookie = cookieOf(boot);
const { countries } = await boot.json();
const byId = new Map(countries.map((c) => [c.id, c]));

// id 0 is International Waters, which has no subdivisions by definition.
const top = board.rows.filter((r) => r[0] !== 0).sort((a, b) => b[1] - a[1])[0];
if (!top) {
  console.log("  SKIP  subdivisions (no country has any pixels yet)");
} else {
  const iso = byId.get(top[0])?.iso_a2;
  const country = await (await fetch(`${BASE}/api/country/${iso}`)).json();
  check("country page returns subdivisions", Array.isArray(country.subdivisions));
  check(
    "the busiest country has at least one named subdivision",
    country.subdivisions.length > 0 && typeof country.subdivisions[0]?.name === "string",
    `${iso}: ${country.subdivisions.map((s) => s.name).join(", ") || "none"}`,
  );
  check(
    "subdivisions are ordered by count",
    country.subdivisions.every((s, i) => i === 0 || s.cumulative <= country.subdivisions[i - 1].cumulative),
  );
}

// ---- area reports: the moderation input path ------------------------------
const X0 = 710000 + Math.floor(Math.random() * 2000);
const Y0 = 710000;

const report = (body, ck = cookie) =>
  fetch(`${BASE}/api/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: ck },
    body: JSON.stringify(body),
  });

const ok = await report({ x0: X0, y0: Y0, x1: X0 + 20, y1: Y0 + 20, reason: "verify run" });
check("a report is accepted", ok.status === 200, `HTTP ${ok.status}`);

const bad = await report({ x0: "nope", y0: Y0, x1: X0, y1: Y0 });
check("non-integer bounds refused", bad.status === 400, `HTTP ${bad.status}`);

const huge = await report({ x0: 0, y0: 0, x1: 99999, y1: 1 });
// Unbounded reports would let anyone queue a thumbnail render of the planet.
check("oversized area refused", huge.status === 422, `HTTP ${huge.status}`);

// ---- admin side -----------------------------------------------------------
const PASS = process.env.VERIFY_ADMIN_PASSWORD;
if (!PASS) {
  console.log("  SKIP  admin report queue (VERIFY_ADMIN_PASSWORD not set)");
} else {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      identifier: process.env.VERIFY_ADMIN_EMAIL ?? "verify@example.com",
      password: PASS,
    }),
  });
  const staffCookie = [cookie, ...(login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])].join("; ");

  const queue = await (
    await fetch(`${BASE}/api/admin/reports`, { headers: { cookie: staffCookie } })
  ).json();
  const rows = Array.isArray(queue) ? queue : (queue.reports ?? []);
  check("the report queue lists reports", rows.length > 0, `${rows.length} rows`);

  const mine = rows.find((r) => r.x0 === X0 && r.y0 === Y0);
  check("the submitted report reaches the queue", Boolean(mine), mine ? `id=${mine.id}` : "not found");

  if (mine) {
    // The thumbnail is what makes triage possible without flying the map to
    // every report, so it has to actually decode.
    const thumb = await fetch(`${BASE}/api/admin/reports/${mine.id}/thumb.png`, {
      headers: { cookie: staffCookie },
    });
    check("thumbnail is served as a PNG", thumb.headers.get("content-type") === "image/png", `HTTP ${thumb.status}`);
    if (thumb.ok) {
      const png = PNG.sync.read(Buffer.from(await thumb.arrayBuffer()));
      check("thumbnail decodes with real dimensions", png.width > 0 && png.height > 0, `${png.width}x${png.height}`);
    }
  }

  // Unauthenticated access must reveal nothing, same as every other admin
  // route: 404, not 403.
  const noAuth = await fetch(`${BASE}/api/admin/reports`);
  check("report queue hidden without a staff role", noAuth.status === 404, `HTTP ${noAuth.status}`);
}

finish(failures, "features");
