/**
 * Seeds the protected landmark at Null Island (0deg, 0deg) - the grid's exact
 * centre, in open ocean in the Gulf of Guinea.
 *
 * It sits there rather than over a city on purpose: it claims nobody's
 * territory, starts no border fight, and scores for International Waters
 * rather than quietly padding one country's leaderboard row.
 *
 *   pnpm seed:landmark            # write it
 *   pnpm seed:landmark -- --force # overwrite an existing one
 *
 * Re-seeding after launch overwrites whatever grew around it, so confirm the
 * pixel text is legible at z12 on a phone BEFORE the first seed.
 */

import {
  INTERNATIONAL_WATERS_ID,
  LANDMARK,
  SITE_NAME,
  SITE_URL,
  tileAncestry,
} from "@worldcanvas/shared";
import { drawRect, drawText, textHeight, textWidth } from "../src/admin/pixelFont.js";
import { pool, tx } from "../src/db/pool.js";

const force = process.argv.includes("--force");

// Palette indices. The landmark sits on water, so the fill is a water colour
// and the terrain rule stays satisfied for anything painted here later.
const BORDER = 4; // White
const FILL = 28; // Navy
const TITLE = 13; // Yellow
const URL_COLOR = 31; // Shallow

interface Pixel {
  x: number;
  y: number;
  color: number;
}

function render(): Pixel[] {
  const w = LANDMARK.width;
  const h = LANDMARK.height;
  // Local buffer first, so overlapping draws resolve before any database
  // work and each pixel is written exactly once.
  const buf = new Int16Array(w * h).fill(-1);
  const at = (x: number, y: number, color: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) buf[y * w + x] = color;
  };

  // Plate: filled rounded-ish block with a white border.
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) at(x, y, FILL);
  }
  drawRect(0, 0, w - 1, h - 1, 2, (x, y) => at(x, y, BORDER));

  // Title, centred, as large as fits.
  const titleScale = 3;
  const tw = textWidth(SITE_NAME, titleScale);
  const th = textHeight(titleScale);
  drawText(
    SITE_NAME,
    Math.floor((w - tw) / 2),
    Math.floor(h / 2) - th,
    titleScale,
    (x, y) => at(x, y, TITLE),
  );

  // URL beneath it, smaller.
  const urlScale = 2;
  const uw = textWidth(SITE_URL, urlScale);
  drawText(
    SITE_URL,
    Math.floor((w - uw) / 2),
    Math.floor(h / 2) + 8,
    urlScale,
    (x, y) => at(x, y, URL_COLOR),
  );

  const pixels: Pixel[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = buf[y * w + x]!;
      if (color >= 0) pixels.push({ x: LANDMARK.x0 + x, y: LANDMARK.y0 + y, color });
    }
  }
  return pixels;
}

async function main(): Promise<void> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pixels
      WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4`,
    [LANDMARK.x0, LANDMARK.x1, LANDMARK.y0, LANDMARK.y1],
  );
  if ((rows[0]?.n ?? 0) > 0 && !force) {
    console.error(`[seed] ${rows[0]!.n} pixels already exist in the landmark area.`);
    console.error("[seed] refusing to overwrite. Re-run with --force if you mean it.");
    process.exit(1);
  }

  const pixels = render();
  console.log(`[seed] rendering "${SITE_NAME}" / "${SITE_URL}" - ${pixels.length} pixels`);

  await tx(async (c) => {
    // One multi-row insert rather than a query per pixel: 30k round trips
    // would take minutes and hold the transaction open throughout.
    const CHUNK = 2000;
    for (let i = 0; i < pixels.length; i += CHUNK) {
      const slice = pixels.slice(i, i + CHUNK);
      await c.query(
        `INSERT INTO pixels (x, y, color, country_id)
         SELECT * FROM UNNEST($1::int[], $2::int[], $3::smallint[], $4::smallint[])
         ON CONFLICT (x, y) DO UPDATE
           SET color = EXCLUDED.color, painted_at = now()`,
        [
          slice.map((p) => p.x),
          slice.map((p) => p.y),
          slice.map((p) => p.color),
          slice.map(() => INTERNATIONAL_WATERS_ID),
        ],
      );
    }

    // Dirty the tile chain once per affected tile, not once per pixel.
    const tiles = new Map<string, { z: number; x: number; y: number }>();
    for (const p of pixels) {
      for (const t of tileAncestry(p.x, p.y)) tiles.set(`${t.z}/${t.x}/${t.y}`, t);
    }
    const chain = [...tiles.values()];
    await c.query(
      `INSERT INTO tile_dirty (z, x, y)
       SELECT * FROM UNNEST($1::smallint[], $2::int[], $3::int[])
       ON CONFLICT DO NOTHING`,
      [chain.map((t) => t.z), chain.map((t) => t.x), chain.map((t) => t.y)],
    );

    // The region row makes the landmark manageable from the admin panel.
    // policy.ts also hardcodes it as a fallback, so deleting this row does
    // not expose it.
    await c.query(
      `INSERT INTO protected_regions (name, x0, y0, x1, y1)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM protected_regions WHERE name = $1)`,
      [LANDMARK.name, LANDMARK.x0, LANDMARK.y0, LANDMARK.x1, LANDMARK.y1],
    );
  });

  console.log(
    `[seed] landmark placed at (${LANDMARK.x0},${LANDMARK.y0})-(${LANDMARK.x1},${LANDMARK.y1}), ${chainSummary(pixels.length)}`,
  );
  await pool.end();
}

const chainSummary = (n: number) => `${n} pixels, protected`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
