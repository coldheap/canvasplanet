/**
 * Does the baked geo index actually attribute real places correctly?
 *
 * This is the check that the leaderboard is meaningful. It paints at known
 * lat/lng points and asserts the country the server assigns, plus the
 * land/water terrain classification that drives the cost rule.
 */
import { finish } from "./finish.mjs";
const BASE = process.env.VERIFY_BASE ?? "http://127.0.0.1:8080";
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

// Web Mercator z12: 4096 tiles * 256 = 1,048,576 pixels per axis.
const WORLD = 1048576;
const lngToX = (lng) => Math.floor(((lng + 180) / 360) * WORLD);
const latToY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * WORLD);
};

// Well inland / well offshore, so a few pixels of coastline error cannot
// flip the expected answer.
const PLACES = [
  { name: "Kuwait City", lat: 29.3759, lng: 47.9774, iso: "KW", terrain: "land" },
  { name: "central France", lat: 47.0, lng: 2.5, iso: "FR", terrain: "land" },
  { name: "Kansas, USA", lat: 38.5, lng: -98.0, iso: "US", terrain: "land" },
  { name: "central Brazil", lat: -14.0, lng: -50.0, iso: "BR", terrain: "land" },
  { name: "central Australia", lat: -25.0, lng: 133.0, iso: "AU", terrain: "land" },
  { name: "Siberia, Russia", lat: 62.0, lng: 95.0, iso: "RU", terrain: "land" },
  { name: "central Egypt", lat: 26.0, lng: 30.0, iso: "EG", terrain: "land" },
  { name: "mid-Pacific", lat: 0.0, lng: -140.0, iso: "XX", terrain: "water" },
  { name: "mid-Atlantic", lat: 30.0, lng: -40.0, iso: "XX", terrain: "water" },
  { name: "central Indian Ocean", lat: -20.0, lng: 80.0, iso: "XX", terrain: "water" },
];

const boot = await fetch(`${BASE}/api/bootstrap`);
const cookie = cookieOf(boot);
const { countries } = await boot.json();
const byId = new Map(countries.map((c) => [c.id, c]));
console.log(`countries loaded: ${countries.length}`);
if (countries.length < 100) {
  console.log("FAIL  countries table looks unbaked - run `pnpm geo:bake`");
  process.exit(1);
}

let failures = 0;
for (const place of PLACES) {
  const x = lngToX(place.lng);
  const y = latToY(place.lat);

  // /api/pixel reports the geo lookup without needing to spend a charge.
  const info = await (await fetch(`${BASE}/api/pixel/${x}/${y}`)).json();
  const country = byId.get(info.countryId);
  const iso = country?.iso_a2 ?? "??";
  const terrain = info.terrain === 1 ? "land" : "water";

  const okCountry = iso === place.iso;
  const okTerrain = terrain === place.terrain;
  if (!okCountry || !okTerrain) failures++;

  console.log(
    `  ${okCountry && okTerrain ? "PASS" : "FAIL"}  ${place.name.padEnd(22)} ` +
      `-> ${iso} ${country?.flag ?? ""} ${terrain}` +
      `${okCountry ? "" : `  (expected ${place.iso})`}` +
      `${okTerrain ? "" : `  (expected ${place.terrain})`}`,
  );
}

// ---- the terrain cost rule, now that terrain is real ----------------------
// Fresh pixels each run: re-using fixed ones makes the second run an
// overpaint (cost 4) and the "empty pixel costs 2" assertion fails for a
// reason that has nothing to do with terrain.
const jitter = () => Math.floor(Math.random() * 400);
const sea = { x: lngToX(-140.0) + jitter(), y: latToY(0.0) + jitter() };
const land = { x: lngToX(2.5) + jitter(), y: latToY(47.0) + jitter() };
const BLUE = 29; // water family
const GREEN = 20; // land family

const paint = async (x, y, color) => {
  const res = await fetch(`${BASE}/api/paint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ x, y, color }),
  });
  return { status: res.status, body: await res.json() };
};

console.log("\nterrain cost rule against real geography:");
const a = await paint(land.x, land.y, GREEN);
console.log(`  ${a.body.cost === 2 ? "PASS" : "FAIL"}  land colour on land   -> cost ${a.body.cost} (expect 2)`);
if (a.body.cost !== 2) failures++;

const b = await paint(sea.x, sea.y, GREEN);
console.log(`  ${b.body.cost === 4 ? "PASS" : "FAIL"}  land colour at sea    -> cost ${b.body.cost} (expect 4, violation)`);
if (b.body.cost !== 4) failures++;

const c = await paint(sea.x, sea.y, BLUE);
console.log(`  ${c.body.cost === 2 ? "PASS" : "FAIL"}  restoring sea to blue -> cost ${c.body.cost} (expect 2, restore)`);
if (c.body.cost !== 2) failures++;

finish(failures, "geo");
