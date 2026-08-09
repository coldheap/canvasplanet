/**
 * Builds `data/geo-index.bin` from the two source datasets.
 *
 *   pnpm geo:fetch   # download, unzip, convert to GeoJSON
 *   pnpm geo:bake
 *
 * Also rewrites the `countries` table in the same run, because the ids
 * written into the binary index must match the ids the database uses.
 * Baking without refreshing the table would silently mis-attribute every
 * future paint.
 *
 * The quadtree descent means open ocean is nearly free; the cost is
 * concentrated on coastlines. Expect single-digit minutes.
 */

import { writeFile } from "node:fs/promises";
import { pool } from "../src/db/pool.js";
import { env } from "../src/env.js";
import { bake, serialise } from "../src/geo/bake.js";
import { PolygonIndex } from "../src/geo/polygonIndex.js";
import {
  COUNTRY_FILE,
  WATER_FILE,
  buildCountryIndex,
  buildWaterIndex,
  countriesPresent,
  loadGeoJson,
  waterPresent,
} from "../src/geo/source.js";

async function main(): Promise<void> {
  if (!countriesPresent()) {
    console.error(`[bake] missing data/${COUNTRY_FILE}. Run \`pnpm geo:fetch\` first.`);
    process.exit(1);
  }

  console.log("[bake] loading country polygons…");
  const { index: countryIdx, rows } = buildCountryIndex(await loadGeoJson(COUNTRY_FILE));
  console.log(`[bake] ${rows.length} countries, ${countryIdx.size} polygons`);

  // Water is optional: without it every pixel is land, so the terrain rule is
  // inert rather than wrong. Countries are not optional.
  let waterIdx = new PolygonIndex();
  if (waterPresent()) {
    console.log("[bake] loading water polygons…");
    waterIdx = buildWaterIndex(await loadGeoJson(WATER_FILE));
    console.log(`[bake] ${waterIdx.size} water polygons`);
  } else {
    console.warn(`[bake] no data/${WATER_FILE} — terrain will be land everywhere.`);
    console.warn(`[bake] the land/water cost rule will never fire until this is baked in.`);
  }

  console.log("[bake] classifying tiles (quadtree descent)…");
  const started = Date.now();
  const result = bake(countryIdx, waterIdx);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const { landTiles, waterTiles, mixedTerrainTiles, mixedCountryTiles, nodesVisited } = result.stats;
  const total = landTiles + waterTiles + mixedTerrainTiles;
  const pct = (n: number) => ((n / total) * 100).toFixed(2);
  console.log(`[bake] done in ${secs}s, ${nodesVisited.toLocaleString()} nodes visited`);
  console.log(`[bake]   land   ${pct(landTiles)}%`);
  console.log(`[bake]   water  ${pct(waterTiles)}%`);
  console.log(`[bake]   mixed  ${pct(mixedTerrainTiles)}%  <- vector fallback at runtime`);
  console.log(`[bake]   mixed country tiles ${pct(mixedCountryTiles)}%`);
  if (mixedTerrainTiles / total > 0.05) {
    console.warn("[bake] WARNING: >5% mixed. The per-tile index stops paying for itself;");
    console.warn("[bake] check the water polygons were simplified, not the full-detail set.");
  }

  const buf = serialise(result);
  await writeFile(env.geoIndexPath, buf);
  console.log(`[bake] wrote ${env.geoIndexPath} (${(buf.byteLength / 1e6).toFixed(1)} MB)`);

  // The ids in the binary and the ids in the database must agree.
  await pool.query(
    `INSERT INTO countries (id, iso_a2, iso_a3, name, flag)
     SELECT * FROM UNNEST($1::smallint[], $2::text[], $3::text[], $4::text[], $5::text[])
     ON CONFLICT (id) DO UPDATE
       SET iso_a2 = EXCLUDED.iso_a2, iso_a3 = EXCLUDED.iso_a3,
           name = EXCLUDED.name, flag = EXCLUDED.flag`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.iso2),
      rows.map((r) => r.iso3),
      rows.map((r) => r.name),
      rows.map((r) => r.flag),
    ],
  );
  await pool.query(
    `INSERT INTO country_stats (country_id) SELECT id FROM countries ON CONFLICT DO NOTHING`,
  );
  console.log(`[bake] countries table synced (${rows.length} + International Waters)`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
