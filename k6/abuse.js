/**
 * DoD abuse test: one IP, 200 fresh cookies.
 *
 *   k6 run k6/abuse.js
 *
 * This is the containment check for "a new session starts with a full bank
 * of 30". Naively, 200 cookie-wipes would be 6,000 free pixels. The IP token
 * bucket must hold the total to 3600 per hour regardless of how many sessions
 * that IP mints.
 *
 * Pass criteria: total successful paints <= 3600 (plus whatever the bucket
 * legitimately refilled during the run).
 */

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
const IP_BUDGET_MAX = 3600;

const totalPainted = new Counter("total_painted_from_one_ip");

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
    // Allow a small margin for tokens that refilled during the run
    // (1 per 1s => ~180 over a 3 minute run).
    total_painted_from_one_ip: [`count<${IP_BUDGET_MAX + 200}`],
  },
};

export default function () {
  // Fresh jar == fresh cookie == fresh session with a full bank of 30.
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
      totalPainted.add(1);
    } else {
      // 429 here is the system working correctly.
      check(res, { "refused with 429": (r) => r.status === 429 });
      break;
    }
  }
}
