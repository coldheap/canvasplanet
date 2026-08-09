/**
 * Timelapse GIF/MP4 export (ROADMAP.md §4.3).
 *
 * The thing worth proving isn't "the route returns 200" — it's that a real
 * ffmpeg process actually ran and produced a real, playable file: the job
 * queue drains a DB-backed queue (not just an in-memory promise), the cache
 * key makes a repeat request free, and the rate limit only bites on a
 * genuinely new encode.
 */
import { finish } from "./finish.mjs";

const BASE = "http://127.0.0.1:8080";
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

async function newSession() {
  const boot = await fetch(`${BASE}/api/bootstrap`);
  return cookieOf(boot);
}

async function paintStrip(cookie, x0, y0, w) {
  for (let i = 0; i < w; i++) {
    const res = await fetch(`${BASE}/api/paint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ x: x0 + i, y: y0, color: 20 + (i % 4) }),
    });
    if (res.status !== 200) throw new Error(`setup paint ${i} -> HTTP ${res.status}`);
  }
}

async function pollUntilDone(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/export/${id}`);
    const body = await res.json();
    if (body.status === "done" || body.status === "failed") return body;
    await sleep(400);
  }
  throw new Error(`export ${id} did not finish within ${timeoutMs}ms`);
}

// ---- session A: GIF, cache hit, rate limit ---------------------------------
const cookieA = await newSession();
const AX0 = 640000 + Math.floor(Math.random() * 5000);
const AY0 = 640000;
await paintStrip(cookieA, AX0, AY0, 4);

const from = Date.now() - 5_000;
const to = Date.now() + 5_000;
const reqBody = { x0: AX0, y0: AY0, x1: AX0 + 3, y1: AY0, from, to, frames: 5, format: "gif" };

const first = await fetch(`${BASE}/api/export/timelapse`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: cookieA },
  body: JSON.stringify(reqBody),
});
check("export request accepted", first.status === 200, `HTTP ${first.status}`);
const firstBody = await first.json();
check("new encode is queued, not immediately done", firstBody.status === "queued", firstBody.status);

const finished = await pollUntilDone(firstBody.id);
check("job reaches status=done", finished.status === "done", JSON.stringify(finished));
check("done job has a download url", typeof finished.url === "string", finished.url);

const file = await fetch(`${BASE}${finished.url}`);
check("file route serves 200", file.status === 200, `HTTP ${file.status}`);
check(
  "content-type is image/gif",
  file.headers.get("content-type") === "image/gif",
  file.headers.get("content-type"),
);
const bytes = Buffer.from(await file.arrayBuffer());
check("file is non-trivial size", bytes.length > 100, `${bytes.length} bytes`);
check("file starts with the GIF magic bytes", bytes.toString("ascii", 0, 3) === "GIF", bytes.toString("ascii", 0, 6));

// Identical params -> cache hit, no new row, no encode.
const again = await fetch(`${BASE}/api/export/timelapse`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: cookieA },
  body: JSON.stringify(reqBody),
});
const againBody = await again.json();
check("repeat request is a cache hit", againBody.status === "cached", JSON.stringify(againBody));
check("cache hit returns the same job id", againBody.id === firstBody.id, `${againBody.id} vs ${firstBody.id}`);

// A genuinely different request from the same session, inside the window,
// must be rate-limited — the cache hit above must not have consumed it.
const rateLimited = await fetch(`${BASE}/api/export/timelapse`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: cookieA },
  body: JSON.stringify({ ...reqBody, x0: AX0 + 100, x1: AX0 + 103 }),
});
check("a second distinct export in the window is rate limited", rateLimited.status === 429, `HTTP ${rateLimited.status}`);

// ---- validation ------------------------------------------------------------
const oversized = await fetch(`${BASE}/api/export/timelapse`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: cookieA },
  body: JSON.stringify({ x0: 0, y0: 0, x1: 99999, y1: 1, from, to, format: "gif" }),
});
check("oversized area refused", oversized.status === 422, `HTTP ${oversized.status}`);

const backwards = await fetch(`${BASE}/api/export/timelapse`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: cookieA },
  body: JSON.stringify({ x0: AX0, y0: AY0, x1: AX0 + 1, y1: AY0, from: to, to: from, format: "gif" }),
});
check("inverted time range refused", backwards.status === 400, `HTTP ${backwards.status}`);

// ---- session B: MP4, odd dimensions (stresses the yuv420p pad filter) -----
const cookieB = await newSession();
const BX0 = 645000 + Math.floor(Math.random() * 5000);
const BY0 = 645000;
// 3x1 — both dimensions odd, exactly what forces the pad filter's ceil(iw/2)*2.
await paintStrip(cookieB, BX0, BY0, 3);

const mp4Req = {
  x0: BX0,
  y0: BY0,
  x1: BX0 + 2,
  y1: BY0,
  from,
  to,
  frames: 3,
  format: "mp4",
};
const mp4First = await fetch(`${BASE}/api/export/timelapse`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: cookieB },
  body: JSON.stringify(mp4Req),
});
check("mp4 export request accepted", mp4First.status === 200, `HTTP ${mp4First.status}`);
const mp4Body = await mp4First.json();
const mp4Finished = await pollUntilDone(mp4Body.id);
check("mp4 job reaches status=done on odd dimensions", mp4Finished.status === "done", JSON.stringify(mp4Finished));

if (mp4Finished.status === "done") {
  const mp4File = await fetch(`${BASE}${mp4Finished.url}`);
  check(
    "mp4 content-type is video/mp4",
    mp4File.headers.get("content-type") === "video/mp4",
    mp4File.headers.get("content-type"),
  );
  const mp4Bytes = Buffer.from(await mp4File.arrayBuffer());
  check("mp4 file is non-trivial size", mp4Bytes.length > 100, `${mp4Bytes.length} bytes`);
  check(
    "mp4 file has the ftyp box (real MP4 container)",
    mp4Bytes.toString("ascii", 4, 8) === "ftyp",
    mp4Bytes.toString("ascii", 0, 12),
  );
}

// ---- unknown id -------------------------------------------------------------
const missing = await fetch(`${BASE}/api/export/00000000-0000-0000-0000-000000000000`);
check("unknown export id is 404", missing.status === 404, `HTTP ${missing.status}`);

finish(failures, "export");
