/**
 * Timelapse: does a known sequence of paints come back as replayable frames,
 * and does replaying them reconstruct the final canvas exactly?
 *
 * This is the check that matters for the player — the endpoint returning 200
 * says nothing about whether `base` plus the frame deltas actually rebuild
 * what is on the canvas.
 */
import { finish } from "./finish.mjs";
const BASE = process.env.VERIFY_BASE ?? "http://127.0.0.1:8080";
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const boot = await fetch(`${BASE}/api/bootstrap`);
const cookie = cookieOf(boot);

// A fresh 8x1 strip, painted left to right, then the first pixel overpainted.
const X0 = 620000 + Math.floor(Math.random() * 2000);
const Y0 = 620000;
const W = 8;
const started = Date.now();

const paint = (x, y, color) =>
  fetch(`${BASE}/api/paint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ x, y, color }),
  });

const expected = new Map();
for (let i = 0; i < W; i++) {
  const color = 20 + (i % 4);
  const res = await paint(X0 + i, Y0, color);
  if (res.status !== 200) {
    console.log(`  FAIL  setup paint ${i} -> HTTP ${res.status}`);
    process.exit(1);
  }
  expected.set(`${X0 + i},${Y0}`, color);
}
// Overpaint the first pixel: the timelapse must show the later value, and
// `base` must still show what was there before the window started.
await paint(X0, Y0, 7);
expected.set(`${X0},${Y0}`, 7);

const to = Date.now() + 1000;
const from = started - 1000;
const res = await fetch(
  `${BASE}/api/timelapse?x0=${X0}&y0=${Y0}&x1=${X0 + W - 1}&y1=${Y0}&from=${from}&to=${to}&frames=20`,
);
check("timelapse responds", res.status === 200, `HTTP ${res.status}`);
const data = await res.json();

check("returns the requested frame count", data.frames?.length === 20, `${data.frames?.length}`);
check("bbox echoes the request", data.bbox?.x0 === X0 && data.bbox?.x1 === X0 + W - 1);
check("is not truncated", data.truncated === false);

const events = data.frames.reduce((n, f) => n + f.p.length, 0);
check("captured every paint", events === W + 1, `${events} events, expected ${W + 1}`);

check(
  "frames are in chronological order",
  data.frames.every((f, i) => i === 0 || f.t >= data.frames[i - 1].t),
);

// Replay exactly as the player does: start from base, apply every frame.
const state = new Map();
for (const [x, y, c] of data.base) state.set(`${x},${y}`, c);
for (const f of data.frames) for (const [x, y, c] of f.p) state.set(`${x},${y}`, c);

let mismatches = 0;
for (const [key, color] of expected) {
  if (state.get(key) !== color) mismatches++;
}
check("replay reconstructs the final canvas", mismatches === 0, `${mismatches} wrong pixels`);

// And it must agree with what the canvas itself reports.
const live = await (await fetch(`${BASE}/api/pixel/${X0}/${Y0}`)).json();
check("final colour matches the live pixel", live.color === state.get(`${X0},${Y0}`), `${live.color}`);

// Bounds are enforced, or this becomes the most expensive query in the app.
const tooBig = await fetch(`${BASE}/api/timelapse?x0=0&y0=0&x1=99999&y1=1&from=${from}&to=${to}`);
check("oversized area refused", tooBig.status === 422, `HTTP ${tooBig.status}`);
const backwards = await fetch(
  `${BASE}/api/timelapse?x0=${X0}&y0=${Y0}&x1=${X0 + 1}&y1=${Y0}&from=${to}&to=${from}`,
);
check("inverted time range refused", backwards.status === 400, `HTTP ${backwards.status}`);

finish(failures, "timelapse");
