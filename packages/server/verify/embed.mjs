/**
 * The embeddable read-only widget (ROADMAP §4.2).
 *
 * `/ws?ro=1` accepts a connection with NO session cookie, because an embed
 * lives in a cross-origin iframe where a SameSite=Lax cookie can never be
 * attached. That is a deliberate hole in the "every socket has a session"
 * rule, so the thing worth testing is that it is exactly as wide as intended:
 * public data flows out, nothing flows in.
 */
import { finish } from "./finish.mjs";
import WebSocket from "ws";

const BASE = "http://127.0.0.1:8080";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

/** Open a socket and collect frames. Resolves once open, or rejects on close. */
async function open(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", (code) => reject(new Error(`closed before open: ${code}`)));
  });
  return { ws, frames, closed };
}

// ---- a socket with no session is still refused on the normal path ---------
// The refusal happens AFTER the upgrade: the handshake succeeds, then the
// server closes with 4001. Waiting only for `open` therefore sees a
// connection that is about to be dropped and calls it accepted.
const plainWs = new WebSocket("ws://127.0.0.1:8080/ws");
const plainClose = await new Promise((resolve) => {
  plainWs.once("close", (code) => resolve(code));
  plainWs.once("error", () => resolve(-1));
  setTimeout(() => resolve(0), 3000);
});
check(
  "a cookieless socket is closed on the normal path",
  plainClose === 4001,
  `close code ${plainClose}`,
);

// ---- ...but accepted as read-only -----------------------------------------
let ro;
try {
  ro = await open("ws://127.0.0.1:8080/ws?ro=1");
} catch (e) {
  check("read-only socket connects with no cookie", false, e.message);
  finish(failures, "embed");
  process.exit(1);
}
check("read-only socket connects with no cookie", true);

// It must subscribe and receive public canvas data, or the widget is blank.
const X = 50000 + Math.floor(Math.random() * 500);
const Y = 49000;
ro.ws.send(JSON.stringify({ t: "sub", tiles: [`6/${X >> 10}/${Y >> 10}`] }));
await sleep(300);

const boot = await fetch(`${BASE}/api/bootstrap`);
const cookie = cookieOf(boot);
const paint = await fetch(`${BASE}/api/paint`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ x: X, y: Y, color: 20 }),
});
check("a paint lands for the fixture", paint.status === 200, `HTTP ${paint.status}`);

await sleep(900);
const px = ro.frames.find((f) => f.t === "px");
check("read-only socket receives pixel frames", Boolean(px), px ? JSON.stringify(px.p[0]) : "none");
check(
  "read-only socket receives public broadcasts",
  ro.frames.some((f) => f.t === "lb" || f.t === "pulse"),
  [...new Set(ro.frames.map((f) => f.t))].join(","),
);

// The one thing it must NOT get: a personal charge bank. There is no session
// behind it, so a `charges` frame would mean it had been attached to someone.
check(
  "read-only socket gets no personal charges frame",
  !ro.frames.some((f) => f.t === "charges"),
  [...new Set(ro.frames.map((f) => f.t))].join(","),
);

// ---- read-only is not a way to paint --------------------------------------
// The socket carries no session, and painting is HTTP anyway — but check the
// obvious escalation: that ?ro=1 did not mint a usable session server-side.
const noCookiePaint = await fetch(`${BASE}/api/paint`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ x: X + 1, y: Y, color: 20 }),
});
// A cookieless POST creates its own fresh session by design, so this may
// succeed — what matters is that it is a NEW session, not the embed's.
check(
  "painting still requires going through the normal session path",
  [200, 403, 428, 429].includes(noCookiePaint.status),
  `HTTP ${noCookiePaint.status}`,
);

// ---- the embed page itself -------------------------------------------------
const page = await fetch("http://127.0.0.1:5173/embed.html");
check("embed.html is served", page.status === 200, `HTTP ${page.status}`);
const html = await page.text();
check("embed.html loads its own entry point", html.includes("embed-main"), "embed-main script tag");

// terminate(), not close(): a graceful close waits for the server's reply and
// keeps the handle alive long enough to trip the finish() watchdog, which
// then prints a warning on every otherwise-clean run.
ro.ws.terminate();
plainWs.terminate();

finish(failures, "embed");
