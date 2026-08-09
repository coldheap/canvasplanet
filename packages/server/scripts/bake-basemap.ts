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
 *
 * Only BASEMAP_MAX_ZOOM (the deepest level) is built the expensive way, via
 * rasterizeTile()'s quadtree descent against the water polygons. Every
 * shallower level is DERIVED from the level below by a 2x2 box filter
 * (majority vote) — the same leaf-first, downsample-from-children strategy
 * tiles/renderer.ts uses for the live pixel canvas's zoomed-out tiles. The
 * first version of this script re-ran the expensive descent independently
 * at every zoom 0..N, which redid overlapping coastline work at every level
 * and made z7+ impractically slow against this repo's full-detail (not
 * simplified) water polygon set; deriving parents from children instead
 * means the descent only ever runs once, at the finest level.
 *
 * The derive pass is I/O-bound (four small file reads + one write per tile,
 * no polygon math) and runs a CONCURRENCY-many pool of tiles at once rather
 * than one at a time — a purely sequential first cut of this measured under
 * 10 tiles/s despite negligible CPU cost per tile, because it paid Node's
 * per-await round-trip latency serially instead of overlapping it.
 *
 * Resumable: if BASEMAP_MAX_ZOOM's tile count already matches what's on
 * disk, the expensive rasterize pass is skipped entirely and only the
 * (cheap) derive pass re-runs — this is what lets deriving get re-tuned or
 * re-run without repeating a 30-minute rasterize.
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { BASEMAP_MAX_ZOOM } from "@worldcanvas/shared";
import { env } from "../src/env.js";
import { TerrainBits, rasterizeTile } from "../src/geo/bake.js";
import { WATER_FILE, buildWaterIndex, loadGeoJson, waterPresent } from "../src/geo/source.js";

const CONCURRENCY = 64;

/** Optional process-level sharding for the expensive leaf pass. Each shard
 * owns disjoint x columns, while already-written files are skipped so an
 * interrupted bake resumes instead of starting over. Run one ordinary pass
 * after all shards finish; it sees a complete leaf level and derives parents. */
const SHARD_COUNT = Math.max(1, Number.parseInt(process.env.BASEMAP_SHARD_COUNT ?? "1", 10));
const SHARD_INDEX = Number.parseInt(process.env.BASEMAP_SHARD_INDEX ?? "0", 10);
if (!Number.isInteger(SHARD_INDEX) || SHARD_INDEX < 0 || SHARD_INDEX >= SHARD_COUNT) {
  throw new Error(`BASEMAP_SHARD_INDEX must be between 0 and ${SHARD_COUNT - 1}`);
}

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

/** Inverse of encodeTile — exact colour match is safe here since PNG is
 *  lossless and this script is the only writer of these files. */
function decodeTile(buf: Buffer): Uint8Array {
  const png = PNG.sync.read(buf);
  const mask = new Uint8Array(TILE_PX * TILE_PX);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    mask[i] = png.data[o] === WATER_RGB[0] && png.data[o + 1] === WATER_RGB[1] ? TerrainBits.Water : TerrainBits.Land;
  }
  return mask;
}

function tilePath(z: number, x: number, y: number): string {
  return join(env.basemapDir, String(z), String(x), `${y}.png`);
}

/** A killed write can leave a zero-byte filename behind. Resume logic must
 * not mistake that for a finished tile. A valid PNG is always larger than
 * its eight-byte signature; decodeTile remains the final integrity check. */
function tileLooksComplete(z: number, x: number, y: number): boolean {
  const path = tilePath(z, x, y);
  return existsSync(path) && statSync(path).size > 8;
}

/** Runs `items` through `work` with at most CONCURRENCY in flight — a plain
 *  pool rather than chunked Promise.all batches, so one slow tile can't
 *  stall the whole batch behind it while the rest of the pool sits idle. */
async function runPool<T>(items: T[], work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

async function writeTile(z: number, x: number, y: number, mask: Uint8Array): Promise<void> {
  const path = tilePath(z, x, y);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodeTile(mask));
}

/**
 * One parent tile's mask, box-filtered (majority vote per 2x2 block) from
 * its four already-baked children. Quadrant layout matches
 * tiles/renderer.ts's renderParentTile exactly.
 */
async function deriveParent(z: number, tx: number, ty: number): Promise<Uint8Array> {
  const half = TILE_PX / 2;
  const out = new Uint8Array(TILE_PX * TILE_PX);
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const child = decodeTile(await readFile(tilePath(z + 1, tx * 2 + dx, ty * 2 + dy)));
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        let waterVotes = 0;
        for (const [ox, oy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          if (child[(y * 2 + oy) * TILE_PX + (x * 2 + ox)] === TerrainBits.Water) waterVotes++;
        }
        out[(dy * half + y) * TILE_PX + (dx * half + x)] = waterVotes >= 2 ? TerrainBits.Water : TerrainBits.Land;
      }
    }
  }
  return out;
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

  // ---- the expensive pass: only the deepest zoom -----------------------
  const z = BASEMAP_MAX_ZOOM;
  const span = 2 ** z;
  const total = span * span;

  const coords: Array<[number, number]> = [];
  for (let tx = SHARD_INDEX; tx < span; tx += SHARD_COUNT) {
    for (let ty = 0; ty < span; ty++) {
      if (!tileLooksComplete(z, tx, ty)) coords.push([tx, ty]);
    }
  }

  if (coords.length === 0) {
    console.log(`[basemap] z${z} already fully baked (${total} tiles) — skipping the rasterize pass`);
  } else {
    let done = 0;
    const shardTotal = coords.length;
    const progressEvery = Math.max(1, Math.round(shardTotal / 20));
    await runPool(coords, async ([tx, ty]) => {
      const mask = rasterizeTile(waterIdx, z, tx, ty, TILE_PX);
      await writeTile(z, tx, ty, mask);
      done++;
      if (done % progressEvery === 0 || done === shardTotal) {
        const secs = (Date.now() - started) / 1000;
        const rate = done / secs;
        const etaSecs = (shardTotal - done) / rate;
        console.log(
          `[basemap] z${z} shard ${SHARD_INDEX + 1}/${SHARD_COUNT}: ${done}/${shardTotal} (${((done / shardTotal) * 100).toFixed(0)}%), ` +
            `${secs.toFixed(0)}s elapsed, ~${etaSecs.toFixed(0)}s left`,
        );
      }
    });
    console.log(`[basemap] z${z} shard ${SHARD_INDEX + 1}/${SHARD_COUNT} done (${shardTotal} tiles written)`);
  }

  // Shards only produce the native leaf level. A final unsharded run verifies
  // that all leaves exist, skips rasterisation, and derives z7..z0 exactly once.
  if (SHARD_COUNT > 1) return;

  // ---- cheap passes: derive every shallower zoom from the one below -----
  for (let pz = z - 1; pz >= 0; pz--) {
    const pspan = 2 ** pz;
    const coords: Array<[number, number]> = [];
    for (let tx = 0; tx < pspan; tx++) {
      for (let ty = 0; ty < pspan; ty++) {
        if (!tileLooksComplete(pz, tx, ty)) coords.push([tx, ty]);
      }
    }

    if (coords.length === 0) {
      console.log(`[basemap] z${pz} already complete (${pspan * pspan} tiles) — skipping`);
      continue;
    }

    await runPool(coords, async ([tx, ty]) => {
      await writeTile(pz, tx, ty, await deriveParent(pz, tx, ty));
    });
    const secs = (Date.now() - started) / 1000;
    console.log(`[basemap] z${pz} derived (${pspan * pspan} tiles) — ${secs.toFixed(0)}s elapsed`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const totalTiles = [...Array(z + 1).keys()].reduce((sum, lvl) => sum + 4 ** lvl, 0);
  console.log(`[basemap] wrote ${totalTiles} tiles to ${env.basemapDir} in ${secs}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
