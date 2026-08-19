/**
 * Templates and the bulk region read — the two endpoints the overlay depends
 * on for progress tracking and sharing.
 */
import { finish } from "./finish.mjs";
import { findEmptyArea } from "./area.mjs";
const BASE = process.env.VERIFY_BASE ?? "http://127.0.0.1:8080";
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

const boot = await fetch(`${BASE}/api/bootstrap`);
const cookie = cookieOf(boot);

// ---- bulk region read -----------------------------------------------------
// Empty ground, asked for rather than guessed: "unpainted reads as 255"
// only means anything if the region really was unpainted to begin with.
const { x: X0, y: Y0 } = await findEmptyArea(6, 4);

// A 4x2 block with a known pattern, leaving the rest of the region unpainted.
const painted = [
  [X0, Y0, 20],
  [X0 + 1, Y0, 21],
  [X0 + 3, Y0 + 1, 7],
];
for (const [x, y, color] of painted) {
  const res = await fetch(`${BASE}/api/paint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ x, y, color }),
  });
  if (res.status !== 200) {
    console.log(`  FAIL  setup paint -> HTTP ${res.status}`);
    process.exit(1);
  }
}

const region = await (
  await fetch(`${BASE}/api/region?x0=${X0}&y0=${Y0}&x1=${X0 + 3}&y1=${Y0 + 1}`)
).json();
check("region reports its shape", region.w === 4 && region.h === 2, `${region.w}x${region.h}`);

const bytes = unb64(region.data);
check("region data is one byte per pixel", bytes.length === 8, `${bytes.length}`);
check("painted pixels have their colours", bytes[0] === 20 && bytes[1] === 21 && bytes[7] === 7);
// 255 means unpainted. Reading it as a colour would make the overlay think
// pixels were already done.
check("unpainted pixels read as 255", bytes[2] === 255 && bytes[4] === 255);

const tooBig = await fetch(`${BASE}/api/region?x0=0&y0=0&x1=99999&y1=1`);
check("oversized region refused", tooBig.status === 422, `HTTP ${tooBig.status}`);

// ---- publish and load -----------------------------------------------------
const W = 6;
const H = 4;
const data = new Uint8Array(W * H);
for (let i = 0; i < data.length; i++) data[i] = i % 5 === 0 ? 255 : i % 32;

const pub = await fetch(`${BASE}/api/templates`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ x: X0, y: Y0, w: W, h: H, data: b64(data) }),
});
const created = await pub.json();
check("template publishes", pub.status === 200 && typeof created.id === "string", JSON.stringify(created));

const loaded = await (await fetch(`${BASE}/api/templates/${created.id}`)).json();
check("template round-trips byte for byte", loaded.data === b64(data));
check("template keeps its placement", loaded.x === X0 && loaded.y === Y0 && loaded.w === W);

// ---- validation -----------------------------------------------------------
const badIndex = await fetch(`${BASE}/api/templates`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ x: 1, y: 1, w: 2, h: 1, data: b64(new Uint8Array([99, 200])) }),
});
check("rejects an out-of-palette index", badIndex.status === 400, `HTTP ${badIndex.status}`);

const wrongLength = await fetch(`${BASE}/api/templates`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ x: 1, y: 1, w: 10, h: 10, data: b64(new Uint8Array(4)) }),
});
check("rejects a length that does not match w*h", wrongLength.status === 400, `HTTP ${wrongLength.status}`);

const huge = await fetch(`${BASE}/api/templates`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ x: 1, y: 1, w: 4097, h: 1, data: b64(new Uint8Array(4097)) }),
});
check("rejects an oversized template", huge.status === 422, `HTTP ${huge.status}`);

// ---- reporting ------------------------------------------------------------
const r1 = await (
  await fetch(`${BASE}/api/templates/${created.id}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    // Fastify rejects an empty body when the content type says JSON, and
    // the real client sends {} here too.
    body: "{}",
  })
).json();
check("report is counted", r1.counted === true);

const r2 = await (
  await fetch(`${BASE}/api/templates/${created.id}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: "{}",
  })
).json();
// One session, one report — otherwise the count a moderator triages by is
// whatever a single person decides it should be.
check("the same session cannot report twice", r2.ok === true && r2.counted === false);

// ---- admin removal --------------------------------------------------------
const PASS_ENV = process.env.VERIFY_ADMIN_PASSWORD;
if (PASS_ENV) {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      identifier: process.env.VERIFY_ADMIN_EMAIL ?? "verify@example.com",
      password: PASS_ENV,
    }),
  });
  const staffCookie = [cookie, ...(login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0])].join("; ");

  const list = await (
    await fetch(`${BASE}/api/admin/templates`, { headers: { cookie: staffCookie } })
  ).json();
  const mine = list.find((t) => t.id === created.id);
  check("admin list surfaces the report count", mine?.reports === 1, `reports=${mine?.reports}`);

  await fetch(`${BASE}/api/admin/templates/${created.id}/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: staffCookie },
    body: JSON.stringify({ removed: true }),
  });
  const gone = await fetch(`${BASE}/api/templates/${created.id}`);
  check("removed template stops resolving", gone.status === 404, `HTTP ${gone.status}`);
} else {
  console.log("  SKIP  admin removal (VERIFY_ADMIN_PASSWORD not set)");
}

finish(failures, "templates");
