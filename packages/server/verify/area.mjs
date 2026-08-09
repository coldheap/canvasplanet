/**
 * Find a rectangle of canvas that is genuinely unpainted.
 *
 * Several checks depend on starting from empty ground — "an empty pixel costs
 * 1", "unpainted reads as 255". They used to pick coordinates from a fixed
 * band with a small random offset, which worked until the canvas had tens of
 * thousands of pixels in it and the suite started colliding with its own
 * history. The failure looked like a cost-table regression and was not.
 *
 * Asking the server is cheap (one bulk region read) and removes the guessing.
 */

const BASE = "http://127.0.0.1:8080";

/** Somewhere far from the landmark and from the k6 load-test bands. */
const MIN = 2_000;
const SPAN = 56_000;

/**
 * Returns {x, y} such that the w×h rectangle from there is entirely
 * unpainted. Throws rather than returning a dirty area — a caller that
 * silently proceeded would produce exactly the confusing failure this exists
 * to prevent.
 */
export async function findEmptyArea(w, h, terrain = "land", attempts = 60) {
  const want = terrain === "land" ? 1 : 0;

  for (let i = 0; i < attempts; i++) {
    const x = MIN + Math.floor(Math.random() * SPAN);
    const y = MIN + Math.floor(Math.random() * SPAN);

    const res = await fetch(`${BASE}/api/region?x0=${x}&y0=${y}&x1=${x + w - 1}&y1=${y + h - 1}`);
    if (!res.ok) continue;
    if ((await res.json()).painted !== 0) continue;

    // Terrain matters as much as emptiness. A land-family colour on sea is a
    // *correct* cost of 2, so a test asserting "an empty pixel costs 1" on a
    // randomly chosen rectangle fails about half the time — 51% of the world
    // is ocean — and looks exactly like a cost-table regression.
    //
    // Sample the corners and centre rather than every pixel: coastlines are
    // the only place these disagree, and a rectangle whose corners and middle
    // all agree is not straddling one.
    const probes = [
      [x, y],
      [x + w - 1, y],
      [x, y + h - 1],
      [x + w - 1, y + h - 1],
      [x + (w >> 1), y + (h >> 1)],
    ];
    const infos = await Promise.all(
      probes.map(([px, py]) => fetch(`${BASE}/api/pixel/${px}/${py}`).then((r) => r.json())),
    );
    if (infos.every((info) => info.terrain === want)) return { x, y };
  }
  throw new Error(`could not find an empty ${w}x${h} ${terrain} area after ${attempts} attempts`);
}
