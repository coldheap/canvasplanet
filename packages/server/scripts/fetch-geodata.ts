/**
 * Downloads and converts the boundary datasets the geo bake needs.
 *
 *   pnpm geo:fetch
 *
 * Both sources ship as zipped shapefiles. Conversion is done in pure JS
 * (the `shapefile` package) rather than shelling out to ogr2ogr, so this
 * needs no GDAL install — which matters because the bake has to be
 * reproducible on a fresh VPS and on Windows.
 *
 *   Natural Earth 1:10m admin_0    country attribution. Borders move slowly,
 *                                  so 1:10m is plenty for "which country".
 *   OSM water polygons (simplified) the land/sea terrain test, where accuracy
 *                                  is visible to every user on every coast.
 *                                  Natural Earth is NOT good enough here: at
 *                                  38 m/pixel its coastlines are off by many
 *                                  pixels in fjords, deltas and small islands,
 *                                  and every one of those is someone charged
 *                                  2 for painting "sea" on dry land.
 *
 * Sources are cached in data/. Re-running skips anything already present.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import * as shapefile from "shapefile";
import { COUNTRY_FILE, DATA_DIR, WATER_FILE } from "../src/geo/source.js";
import { SUBDIVISION_FILE } from "../src/geo/subdivisions.js";
import { ASN_FILE } from "../src/security/asn.js";

interface Source {
  name: string;
  url: string;
  zip: string;
  /** Output GeoJSON filename. */
  out: string;
  note: string;
  /** Source is EPSG:3857 (metres) and must be converted to lon/lat. */
  reproject?: boolean;
  /** Skip this source rather than failing the run if it cannot be fetched. */
  optional?: boolean;
}

/** Half the Web Mercator world in metres — the EPSG:3857 extent. */
const MERC_MAX = 20037508.342789244;

/**
 * EPSG:3857 metres -> EPSG:4326 degrees.
 *
 * All the geometry in `shared` works in lon/lat, so anything arriving in
 * projected metres has to be converted once here rather than at query time.
 */
function toLonLat(x: number, y: number): [number, number] {
  const lon = (x / MERC_MAX) * 180;
  const lat = (Math.atan(Math.exp(((y / MERC_MAX) * 180 * Math.PI) / 180)) * 360) / Math.PI - 90;
  return [lon, lat];
}

/** Walk a GeoJSON coordinate tree of any nesting depth and reproject leaves. */
function reprojectCoords(node: unknown): unknown {
  if (!Array.isArray(node)) return node;
  if (typeof node[0] === "number" && typeof node[1] === "number") {
    return toLonLat(node[0], node[1]);
  }
  return node.map(reprojectCoords);
}

const SOURCES: Source[] = [
  {
    name: "countries",
    url: "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip",
    zip: "ne_countries.zip",
    out: COUNTRY_FILE,
    note: "Natural Earth 1:10m countries (public domain)",
  },
  {
    name: "water",
    url: "https://osmdata.openstreetmap.de/download/simplified-water-polygons-split-3857.zip",
    zip: "osm_water.zip",
    out: WATER_FILE,
    note: "OSM simplified water polygons (ODbL — attribution required in the UI)",
    // The simplified set (23 MB) rather than the full one (861 MB): at 38 m
    // per pixel we classify 9.8 km tiles, so full-detail coastline geometry
    // costs two orders of magnitude more download and memory to resolve
    // detail below one pixel. Still far more accurate than Natural Earth,
    // which was the point of using OSM here at all.
    reproject: true,
    // Occasionally rate-limited. Without it the terrain rule falls back to
    // "everything is land", which is inert rather than wrong.
    optional: true,
  },
  {
    name: "subdivisions",
    url: "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip",
    zip: "ne_subdivisions.zip",
    out: SUBDIVISION_FILE,
    note: "Natural Earth 1:10m states/provinces (public domain)",
    // Purely a country-page enrichment (regional breakdown), never part of
    // paint pricing or attribution. Without it /api/country/:iso simply
    // omits the subdivisions list.
    optional: true,
  },
];

/**
 * The IP-to-ASN database powers anti-bot layer 2. Plain CSV, no shapefile
 * step, and CC0 licensed — so it is fetched separately from the two
 * boundary datasets rather than shoehorned into the Source shape.
 */
const ASN_SOURCE = {
  url: "https://cdn.jsdelivr.net/npm/@ip-location-db/asn/asn-ipv4-num.csv",
  out: ASN_FILE,
  note: "IP-to-ASN ranges, @ip-location-db (CC0)",
};

const exists = async (p: string) => {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
};

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url} -> HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

/** Extract the zip and return the path of the .shp inside it. */
async function extractShp(zipPath: string, into: string): Promise<string> {
  await mkdir(into, { recursive: true });
  new AdmZip(zipPath).extractAllTo(into, true);

  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  };

  const files = await walk(into);
  const shp = files.find((f) => f.toLowerCase().endsWith(".shp"));
  if (!shp) throw new Error(`no .shp found inside ${zipPath}`);
  return shp;
}

/**
 * Stream the shapefile into a GeoJSON FeatureCollection.
 *
 * Written incrementally rather than assembled in memory: the water polygons
 * are hundreds of MB of coordinates and JSON.stringify on the whole thing
 * would blow the heap.
 */
async function shpToGeoJson(
  shpPath: string,
  outPath: string,
  reproject: boolean,
): Promise<number> {
  const out = createWriteStream(outPath);
  const write = (s: string) =>
    new Promise<void>((resolve, reject) =>
      out.write(s, (err) => (err ? reject(err) : resolve())),
    );

  await write('{"type":"FeatureCollection","features":[');
  const source = await shapefile.open(shpPath);
  let count = 0;
  for (let r = await source.read(); !r.done; r = await source.read()) {
    const f = r.value as
      | { geometry: { type: string; coordinates: unknown } | null; properties: unknown }
      | undefined;
    if (!f?.geometry) continue;

    const geometry = reproject
      ? { type: f.geometry.type, coordinates: reprojectCoords(f.geometry.coordinates) }
      : f.geometry;

    if (count > 0) await write(",");
    // Water polygons carry no useful attributes and there are ~180k of them,
    // so dropping properties saves a lot of bytes for nothing lost.
    await write(
      JSON.stringify({
        type: "Feature",
        properties: reproject ? {} : f.properties,
        geometry,
      }),
    );
    count++;
    if (count % 25000 === 0) console.log(`[geo]   …${count.toLocaleString()} features`);
  }
  await write("]}");
  await new Promise<void>((resolve) => out.end(resolve));
  return count;
}

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  for (const src of SOURCES) {
    const outPath = join(DATA_DIR, src.out);
    if (await exists(outPath)) {
      console.log(`[geo] ${src.out} already present — skipping`);
      continue;
    }

    const zipPath = join(DATA_DIR, src.zip);
    try {
      if (!(await exists(zipPath))) {
        console.log(`[geo] fetching ${src.note}`);
        await download(src.url, zipPath);
      }
      console.log(`[geo] extracting ${src.zip}…`);
      const workDir = join(DATA_DIR, `_${src.name}`);
      const shp = await extractShp(zipPath, workDir);

      console.log(`[geo] converting ${src.name} to GeoJSON…`);
      const n = await shpToGeoJson(shp, outPath, src.reproject === true);
      const mb = ((await stat(outPath)).size / 1e6).toFixed(1);
      console.log(`[geo] wrote ${src.out} — ${n.toLocaleString()} features, ${mb} MB`);

      await rm(workDir, { recursive: true, force: true });
    } catch (err) {
      if (!src.optional) throw err;
      console.warn(`[geo] optional source "${src.name}" failed: ${(err as Error).message}`);
      console.warn(`[geo] the bake will treat all non-ocean pixels as land.`);
    }
  }

  // ---- ASN database (anti-bot layer 2) -----------------------------------
  const asnPath = join(DATA_DIR, ASN_SOURCE.out);
  if (await exists(asnPath)) {
    console.log(`[geo] ${ASN_SOURCE.out} already present — skipping`);
  } else {
    try {
      console.log(`[geo] fetching ${ASN_SOURCE.note}`);
      await download(ASN_SOURCE.url, asnPath);
      const mb = ((await stat(asnPath)).size / 1e6).toFixed(1);
      console.log(`[geo] wrote ${ASN_SOURCE.out} — ${mb} MB`);
    } catch (err) {
      // Optional: without it, ASN gating is simply off and the other three
      // anti-bot layers still apply.
      console.warn(`[geo] ASN database failed: ${(err as Error).message}`);
      console.warn(`[geo] ASN gating will be disabled.`);
    }
  }

  console.log("[geo] done. Next: pnpm geo:bake");
  console.log("[geo] ODbL requires crediting OpenStreetMap in the UI — the map attribution covers it.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
