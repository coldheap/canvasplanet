/**
 * The tile pipeline: does a painted pixel land at the right offset, in the
 * right PNG, with everything around it left transparent so the basemap shows
 * through — and does the parent mipmap pick it up?
 *
 * Paints its own pixel rather than assuming one from an earlier run, so it is
 * self-contained and safe to run after a revert.
 */
import { finish } from "./finish.mjs";
import { PNG } from "pngjs";

const BASE = "http://127.0.0.1:8080";
const COLOR = 7; // "Red" #ED1C24
const EXPECTED_HEX = "#ED1C24";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

// Somewhere quiet, fresh each run so the pixel is ours and unpainted.
const X = 600000 + Math.floor(Math.random() * 200);
const Y = 600000 + Math.floor(Math.random() * 200);
const tx = X >> 8;
const ty = Y >> 8;

const boot = await fetch(`${BASE}/api/bootstrap`);
const cookie = cookieOf(boot);
const paint = await fetch(`${BASE}/api/paint`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ x: X, y: Y, color: COLOR }),
});
check("paint accepted", paint.status === 200, `HTTP ${paint.status}`);
if (paint.status !== 200) process.exit(1);

// The tile worker debounces; give it a beat to re-render and purge.
await sleep(3500);

const res = await fetch(`${BASE}/tiles/12/${tx}/${ty}.png?cachebust=${Date.now()}`);
check("tile served as a PNG", res.headers.get("content-type") === "image/png");
const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
console.log(`tile 12/${tx}/${ty}  ${png.width}x${png.height}  pixel (${X},${Y})`);

check("tile is 256x256", png.width === 256 && png.height === 256);

const idx = ((Y & 255) * 256 + (X & 255)) * 4;
const [r, g, b, a] = [png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]];
const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("");
check("pixel is at the right offset in the right colour", hex === EXPECTED_HEX && a === 255, `${hex} a=${a}`);

// A neighbour must be fully transparent, or the OSM basemap cannot show
// through and the canvas would render as an opaque sheet.
const n = ((Y & 255) * 256 + ((X & 255) + 1)) * 4;
check("neighbouring pixel is transparent", png.data[n + 3] === 0, `alpha=${png.data[n + 3]}`);

// The parent is built by mipmap downsample, not re-queried, so a non-empty
// child must produce a non-empty parent.
const p = await fetch(`${BASE}/tiles/11/${tx >> 1}/${ty >> 1}.png?cachebust=${Date.now()}`);
const pp = PNG.sync.read(Buffer.from(await p.arrayBuffer()));
let opaque = 0;
for (let i = 3; i < pp.data.length; i += 4) if (pp.data[i] > 0) opaque++;
check("parent tile mipmapped from the child", opaque > 0, `${opaque} non-transparent px`);

finish(failures, "tiles");
