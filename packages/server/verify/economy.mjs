/**
 * Economy exhaustion check, against the real server and real Postgres.
 *
 * A fresh session starts with a full bank and regenerates at a configured
 * rate. It must be able to spend the bank and no more — the double-spend
 * check that unit tests structurally cannot make, because it needs the real
 * transaction under a real connection.
 *
 * The assertion is deliberately an AGGREGATE one. A fixed paint count was
 * once equivalent to exhausting the bank, but the economy is tunable and
 * at one charge per second the loop itself takes long enough to earn several
 * more — so a fixed count tests the clock, not the ledger.
 */
import { finish } from "./finish.mjs";
import { findEmptyArea } from "./area.mjs";
const BASE = "http://127.0.0.1:8080";
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const boot = await fetch(`${BASE}/api/bootstrap`);
const cookie = cookieOf(boot);
const { bank: startBank, max, regenMs } = await boot.json();
console.log(`fresh session: ${startBank}/${max} charges, +1 per ${regenMs}ms`);

check("a fresh session starts with a full bank", startBank === max, `${startBank}/${max}`);

// Land-family colour on empty pixels => base cost (2 charges) each.
const COLOR = 20;
// Genuinely empty ground, asked for rather than guessed at: the canvas now
// holds tens of thousands of pixels and a fixed band collides with earlier
// runs, which shows up as "cost 4, expected 2" and looks like a cost-table
// regression.
const { x: baseX, y: baseY } = await findEmptyArea(64, 7);

const started = Date.now();
let spent = 0;
let placed = 0;
let refusal = null;

// Spend until refused. The cap is generous so this terminates even when
// regeneration is fast, without assuming a particular rate.
for (let i = 0; i < 400; i++) {
  const res = await fetch(`${BASE}/api/paint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ x: baseX + (i % 64), y: baseY + Math.floor(i / 64), color: COLOR }),
  });
  const body = await res.json();
  if (res.status === 200) {
    placed++;
    spent += body.cost;
    if (body.cost !== 2) check(`pixel ${i} cost ${body.cost}, expected 2`, false);
  } else {
    refusal = { status: res.status, body };
    break;
  }
}

// Charges that could possibly have been earned by the moment of refusal,
// plus one to absorb the round trip between the server's clock and ours.
const earned = startBank + Math.floor((Date.now() - started) / regenMs) + 1;

console.log(`placed ${placed} pixels (${spent} charges) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
check("was eventually refused", refusal !== null);
check("refused with 429", refusal?.status === 429, `HTTP ${refusal?.status}`);
check("reason is no_charges", refusal?.body?.reason === "no_charges", refusal?.body?.reason);
check(
  "never spent more than it could have earned",
  spent <= earned,
  `spent ${spent}, could have earned ${earned}`,
);
check("spent at least the starting bank", spent >= startBank, `${spent} >= ${startBank}`);
check(
  "retryAfterMs is a sane countdown",
  refusal?.body?.retryAfterMs > 0 && refusal.body.retryAfterMs <= regenMs * 2,
  `${refusal?.body?.retryAfterMs}ms`,
);

// A brand-new session must not inherit the exhausted one's state.
const boot2 = await fetch(`${BASE}/api/bootstrap`);
const fresh = (await boot2.json()).bank;
check("a second fresh session is unaffected", fresh === max, `${fresh}/${max}`);

finish(failures, "economy");
