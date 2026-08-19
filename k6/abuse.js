/**
 * DoD abuse test: one IP, 200 fresh cookies.
 *
 *   k6 run k6/abuse.js
 *
 * This is the containment check for "a new session starts with a full bank
 * of 60". Naively, 200 cookie-wipes would mint 12,000 charges. The IP token
 * bucket must hold total spend to 120 charges per hour regardless of how many
 * sessions that IP mints.
 *
 * Pass criteria: total charges spent <= 120 plus whatever the bucket
 * legitimately refilled during the run.
 */

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
const IP_BUDGET_MAX = 120;
const IP_BUDGET_REFILL_MS = 30000;
const MAX_DURATION_SECONDS = 180;
const REFILL_SLACK = Math.ceil((MAX_DURATION_SECONDS * 1000) / IP_BUDGET_REFILL_MS) + 2;

const chargesSpent = new Counter("charges_spent_from_one_ip");

export const options = {
  scenarios: {
    farm: {
      executor: "shared-iterations",
      vus: 10,
      iterations: 200, // 200 fresh sessions
      maxDuration: "3m",
    },
  },
  thresholds: {
    // Allow the six charges that can refill during a three-minute run, plus
    // two charges for setup/request timing at the boundary.
    charges_spent_from_one_ip: [`count<=${IP_BUDGET_MAX + REFILL_SLACK}`],
  },
};

export default function () {
  // Fresh jar == fresh cookie == fresh session with a full bank of 60.
  const jar = http.cookieJar();
  jar.clear(BASE);
  http.get(`${BASE}/api/bootstrap`);

  // Quiet z12 band, away from the protected landmark.
  const x = 200000 + Math.floor(Math.random() * 100000);
  const y = 200000 + Math.floor(Math.random() * 100000);

  // Try to burn the whole fresh bank immediately — the exploit this defends.
  for (let i = 0; i < 30; i++) {
    const res = http.post(
      `${BASE}/api/paint`,
      JSON.stringify({ x: x + i, y, color: 7 }),
      { headers: { "Content-Type": "application/json" } },
    );
    if (res.status === 200) {
      chargesSpent.add(res.json("cost"));
    } else {
      // 429 here is the system working correctly.
      check(res, { "refused with 429": (r) => r.status === 429 });
      break;
    }
  }
}
