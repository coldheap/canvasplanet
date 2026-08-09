/**
 * DoD load test: 50 concurrent clients painting as fast as the cooldown allows.
 *
 *   pnpm load
 *
 * Each VU is a distinct session AND a distinct IP. The distinct IP matters:
 * with all 50 sharing one address they contend on a single ip_budget row and
 * the run measures the rate limiter rather than paint throughput, and the
 * shared 120/hour ceiling starves everyone after ~120 paints.
 *
 * Spoofing the IP requires TRUST_CF_CONNECTING_IP=true on the server, which
 * is also how it runs behind Cloudflare. Do not set that flag on an origin
 * reachable from the internet — see session.ts.
 *
 * Pass criteria (PLAN.md §12):
 *   - p99 successful paint < 200 ms
 *   - zero double-spends
 *   - no dropped WebSocket clients
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
// Read from the server at setup rather than hardcoded: the economy is
// tunable in shared/config.ts, and a stale copy here turns every legitimate
// post-cooldown paint into a false double-spend report.
let CHARGE_MAX = 30;
let REGEN_MS = 30000;

const painted = new Counter("pixels_painted");
const refused = new Counter("paints_refused_expected");
const unexpected = new Counter("paints_failed_unexpected");
const overspend = new Counter("overspend_bugs");
const paintLatency = new Trend("paint_latency_ok", true);
const okRate = new Rate("paint_success");

export const options = {
  scenarios: {
    painters: { executor: "constant-vus", vus: 50, duration: __ENV.DURATION || "60s" },
  },
  thresholds: {
    // The real assertion: the server must never grant a paint the bank
    // could not afford.
    overspend_bugs: ["count==0"],
    // Latency of SUCCESSFUL paints only. A 429 is fast and cheap and would
    // otherwise flatter the average.
    paint_latency_ok: ["p(99)<200"],
    // 429 is correct behaviour here, so it must not count as a failure.
    // Only genuinely unexpected statuses do.
    paints_failed_unexpected: ["count==0"],
  },
};

// Cap how many VUs are allowed to land in the same country. Below this, a
// "spread across the world" coordinate formula still funnels most VUs into
// International Waters (~70% of the globe is ocean, and it is one country_id
// like any other) — every one of them then serializes on that single
// country_stats row for the back half of its transaction, same as the
// single-tile contention this file already spreads VUs to avoid. Confirmed
// with a real isolated load run (scratch DB, separate port): the original
// formula put 37 of 50 VUs in International Waters and pg_stat_activity
// showed real Lock waits on the paint CTE the whole run — a measurement
// artifact of this script, not a server bug.
const MAX_VUS_PER_COUNTRY = 3;

export function setup() {
  const res = http.get(`${BASE}/api/bootstrap`);
  check(res, { "bootstrap ok": (r) => r.status === 200 });

  // One coordinate per VU, resolved against the real geo index (not
  // guessed) so the cap above is enforced on the country the server will
  // actually attribute the paint to.
  const countryCounts = {};
  const coords = [];
  for (let vu = 1; vu <= 50; vu++) {
    let x, y, countryId;
    for (let tries = 0; tries < 40; tries++) {
      const seed = vu + tries * 977;
      x = 100000 + ((seed * 7919) % 800000);
      y = 100000 + ((seed * 104729) % 800000);
      const px = http.get(`${BASE}/api/pixel/${x}/${y}`);
      countryId = px.json("countryId");
      if ((countryCounts[countryId] ?? 0) < MAX_VUS_PER_COUNTRY) break;
    }
    countryCounts[countryId] = (countryCounts[countryId] ?? 0) + 1;
    coords.push({ x, y });
  }

  return { max: res.json("max"), regenMs: res.json("regenMs"), coords };
}

export default function (config) {
  // setup() runs once in its own context; VUs get its return value here.
  CHARGE_MAX = config.max ?? CHARGE_MAX;
  REGEN_MS = config.regenMs ?? REGEN_MS;

  // Distinct cookie jar per VU == distinct session == its own charge bank.
  const jar = http.cookieJar();
  jar.clear(BASE);

  // Distinct simulated client IP per VU.
  const ip = `203.0.${Math.floor(__VU / 256) % 256}.${__VU % 256}`;
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };

  const boot = http.get(`${BASE}/api/bootstrap`, { headers });
  if (boot.status !== 200) {
    unexpected.add(1);
    return;
  }

  // Double-spend detection, as an AGGREGATE invariant over the session.
  //
  // Two earlier formulations were wrong. Inferring the bank from a 429 does
  // not work ("no_charges" means bank < cost, not bank == 0). And checking
  // each paint against a locally-modelled bank produces false positives at
  // the regeneration boundary: this clock starts when the response arrives,
  // while the server's started before it processed the request, so the
  // server legitimately grants a charge a fraction of a second before the
  // model credits it.
  //
  // What actually must hold, and is immune to both: across the whole
  // session, total charges spent can never exceed the starting bank plus
  // what could have regenerated. One charge of slack absorbs the skew.
  const startBank = boot.json("bank");
  const sessionStart = Date.now();
  let spent = 0;
  const everAllowed = () =>
    startBank + Math.floor((Date.now() - sessionStart) / REGEN_MS) + 1;

  // Spread VUs across the world so they do not contend on one tile, or (see
  // MAX_VUS_PER_COUNTRY above) pile up on one country_stats row — either one
  // would measure lock contention, not throughput.
  const { x: baseX, y: baseY } = config.coords[__VU - 1];

  for (let i = 0; i < 60; i++) {
    const res = http.post(
      `${BASE}/api/paint`,
      JSON.stringify({ x: baseX + (i % 64), y: baseY + Math.floor(i / 64), color: i % 32 }),
      { headers, tags: { name: "paint" } },
    );

    okRate.add(res.status === 200);

    if (res.status === 200) {
      painted.add(1);
      paintLatency.add(res.timings.duration);
      spent += res.json("cost");
      // The session has now been charged more than it could ever have
      // earned. That is a real double-spend.
      if (spent > everAllowed()) overspend.add(1);
    } else if (res.status === 429) {
      // Correct behaviour, for either reason. Deliberately does not touch
      // the local mirror: a 429 tells us bank < cost, not what bank is.
      refused.add(1);
      sleep(2);
    } else if (res.status === 428) {
      // Turnstile is enabled; this test cannot solve it. Run with blank
      // TURNSTILE_* env vars.
      unexpected.add(1);
      return;
    } else {
      unexpected.add(1);
    }

    sleep(0.2);
  }
}
