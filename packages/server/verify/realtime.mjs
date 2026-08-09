/**
 * End-to-end realtime check: does a paint from session A reach a WebSocket
 * client subscribed to that tile as session B, within ~1s? (DoD item 4.)
 *
 * Also checks that a client subscribed elsewhere receives nothing — the
 * viewport filtering is what stops bandwidth being O(clients x paints).
 */
import { finish } from "./finish.mjs";
import WebSocket from "ws";

const BASE = "http://127.0.0.1:8080";
const COLOR = 20;
// Fresh pixels each run so the cost stays 1 and the assertions stay stable.
const X = 44000 + Math.floor(Math.random() * 200);
const Y = 44000 + Math.floor(Math.random() * 200);

const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

// Two independent anonymous sessions.
const bootA = await fetch(`${BASE}/api/bootstrap`);
const cookieA = cookieOf(bootA);
const bootB = await fetch(`${BASE}/api/bootstrap`);
const cookieB = cookieOf(bootB);
console.log(`session A bank=${(await bootA.json()).bank}  session B bank=${(await bootB.json()).bank}`);

/** Open a socket and subscribe, resolving only once both are done. */
async function watcher(cookie, tiles) {
  const ws = new WebSocket(`ws://127.0.0.1:8080/ws`, { headers: { cookie } });
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", (code) => reject(new Error(`closed before open: ${code}`)));
  });
  ws.send(JSON.stringify({ t: "sub", tiles }));
  // Let the subscription register before anything is painted.
  await sleep(250);
  return { ws, frames };
}

// SUB_ZOOM is 6, so the shift from pixel space is 8-6+8 = 10.
const subKey = `6/${X >> 10}/${Y >> 10}`;
const onTile = await watcher(cookieB, [subKey]);
const elsewhere = await watcher(cookieB, ["6/0/0"]);
console.log(`B watching ${subKey}; second client watching 6/0/0`);

check(
  "initial charges frame delivered on connect",
  onTile.frames.some((f) => f.t === "charges"),
);

// ---- the measurement ------------------------------------------------------
// The clock starts HERE, after both sockets are open and subscribed, so it
// measures paint->delivery and not the WebSocket handshake.
const t0 = Date.now();
const paint = await fetch(`${BASE}/api/paint`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: cookieA },
  body: JSON.stringify({ x: X, y: Y, color: COLOR }),
});
const paintBody = await paint.json();
console.log(`A painted (${X},${Y}) -> ${paint.status} ${JSON.stringify(paintBody)}`);

let px = null;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !px) {
  px = onTile.frames.find((f) => f.t === "px");
  if (!px) await sleep(25);
}
const latency = Date.now() - t0;

check("paint accepted", paint.status === 200);
check("subscriber received a px frame", Boolean(px));
check("delivered within 1s", Boolean(px) && latency < 1000, `${latency}ms`);
if (px) {
  const [cx, cy, cc] = px.p[0];
  check("payload matches the paint", cx === X && cy === Y && cc === COLOR, JSON.stringify(px.p[0]));
}

// ---- viewport filtering ---------------------------------------------------
await sleep(500);
check(
  "off-tile client received nothing",
  !elsewhere.frames.some((f) => f.t === "px"),
  `${elsewhere.frames.filter((f) => f.t === "px").length} leaked frames`,
);

onTile.ws.close();
elsewhere.ws.close();
finish(failures, "realtime");
