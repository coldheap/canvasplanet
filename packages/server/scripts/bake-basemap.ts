/**
 * Builds the static land/ocean backdrop the pixel canvas sits on when the
 * OSM overlay is off (see MapCanvas.tsx's layer stack and ROADMAP.md's
 * "just pixels" default). Two flat colours, no roads or labels — just
 * enough to keep unpainted ocean/land reading correctly.
 *
 *   pnpm geo:fetch          # download, unzip, convert to GeoJSON (if not done)
 *   pnpm geo:bake-basemap
 *
 * Unlike bake-geo.ts this never touches the database or the per-pixel geo
 * index — it only reads the water polygons and writes a small PNG pyramid
 * to `env.basemapDir`, served as-is by routes/basemap.ts. Safe to re-run any
 * time the water source data changes; nothing else depends on its output at
 * boot.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { BASEMAP_MAX_ZOOM } from "@worldcanvas/shared";
import { env } from "../src/env.js";
import { TerrainBits, rasterizeTile } from "../src/geo/bake.js";
import { WATER_FILE, buildWaterIndex, loadGeoJson, waterPresent } from "../src/geo/source.js";

const TILE_PX = 256;
/** Matches the OSM "standard" style's usual land/ocean read closely enough
 *  to feel familiar, without shipping roads or labels. */
const WATER_RGB: [number, number, number] = [170, 211, 223];
const LAND_RGB: [number, number, number] = [242, 239, 233];

function encodeTile(mask: Uint8Array): Buffer {
  const png = new PNG({ width: TILE_PX, height: TILE_PX });
  for (let i = 0; i < mask.length; i++) {
    const rgb = mask[i] === TerrainBits.Water ? WATER_RGB : LAND_RGB;
    const o = i * 4;
    png.data[o] = rgb[0];
    png.data[o + 1] = rgb[1];
    png.data[o + 2] = rgb[2];
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function main(): Promise<void> {
  if (!waterPresent()) {
    console.error(`[basemap] missing data/${WATER_FILE}. Run \`pnpm geo:fetch\` first.`);
    process.exit(1);
  }

  console.log("[basemap] loading water polygons…");
  const waterIdx = buildWaterIndex(await loadGeoJson(WATER_FILE));
  console.log(`[basemap] ${waterIdx.size} water polygons`);

  const started = Date.now();
  let tiles = 0;
  for (let z = 0; z <= BASEMAP_MAX_ZOOM; z++) {
    const span = 2 ** z;
    for (let tx = 0; tx < span; tx++) {
      for (let ty = 0; ty < span; ty++) {
        const mask = rasterizeTile(waterIdx, z, tx, ty, TILE_PX);
        const buf = encodeTile(mask);
        const path = join(env.basemapDir, String(z), String(tx), `${ty}.png`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, buf);
        tiles++;
      }
    }
    console.log(`[basemap] z${z} done (${span * span} tiles)`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[basemap] wrote ${tiles} tiles to ${env.basemapDir} in ${secs}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
