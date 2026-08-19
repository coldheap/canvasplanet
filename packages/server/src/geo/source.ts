/**
 * Loading the source GeoJSON.
 *
 * Shared by the bake script and the server runtime, because the runtime
 * needs the same polygons to resolve MIXED tiles that the bake used to
 * decide they were mixed. If these two ever loaded different data, coastal
 * pixels would be priced one way at bake time and another at paint time.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Poly } from "@canvasplanet/shared";
import { PolygonIndex } from "./polygonIndex.js";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../data");

export const COUNTRY_FILE = "ne_10m_admin_0_countries.geojson";
export const WATER_FILE = "water_polygons.geojson";

export interface GeoJsonFeature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}

export async function loadGeoJson(file: string): Promise<GeoJsonFeature[]> {
  const raw = await readFile(join(DATA_DIR, file), "utf8");
  const parsed = JSON.parse(raw) as { features?: GeoJsonFeature[] };
  if (!parsed.features) throw new Error(`${file} is not a FeatureCollection`);
  return parsed.features;
}

/** Normalise Polygon and MultiPolygon into a flat list of polygons. */
export function toPolys(geometry: GeoJsonFeature["geometry"]): Poly[] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates as Poly];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as Poly[];
  return [];
}

/** Matches NUL through 0x1f. Built via RegExp so the source file itself
 *  contains no literal control characters. */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f]", "g");

/**
 * Read a string attribute from a shapefile DBF record.
 *
 * DBF fields are fixed-width and NUL-padded, so values arrive with trailing
 * 0x00 bytes. Postgres rejects those outright ("invalid byte sequence for
 * encoding UTF8"), so they have to be stripped here rather than at the query.
 */
export const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(CONTROL_CHARS, "").trim();
  return cleaned ? cleaned : null;
};

/**
 * Fit a value to a fixed-width CHAR(n) column.
 *
 * Natural Earth's ISO fields are not reliably 2 and 3 characters — some
 * entities carry longer codes or the "-99" placeholder — and Postgres
 * rejects an overflow outright rather than truncating (SQLSTATE 22001).
 * Anything that is not exactly the right shape becomes NULL rather than a
 * silently mangled code.
 */
export function isoCode(v: unknown, width: number): string | null {
  const s = str(v);
  if (!s || s === "-99") return null;
  return s.length === width && /^[A-Za-z]+$/.test(s) ? s.toUpperCase() : null;
}

/**
 * Assign country ids the same way every time.
 *
 * The order is the file's feature order, so a re-bake of the SAME source
 * file reproduces identical ids. Swapping in a newer Natural Earth release
 * can renumber everything, which is why bake-geo.ts rewrites the countries
 * table in the same run.
 */
export function buildCountryIndex(features: GeoJsonFeature[]): {
  index: PolygonIndex;
  rows: Array<{ id: number; iso2: string; iso3: string | null; name: string; flag: string }>;
} {
  const index = new PolygonIndex();
  const rows: Array<{ id: number; iso2: string; iso3: string | null; name: string; flag: string }> = [];

  let nextId = 1; // 0 is reserved for International Waters
  for (const f of features) {
    const p = f.properties;
    const iso2 = isoCode(p.ISO_A2, 2) ?? isoCode(p.ISO_A2_EH, 2) ?? isoCode(p.WB_A2, 2);
    const name = str(p.ADMIN) ?? str(p.NAME) ?? "Unknown";
    const id = nextId++;
    if (id > 0xfffe) throw new Error("more than 65534 countries - widen the index to u32");

    // Natural Earth uses "-99" for entities with no assigned ISO code
    // (Kosovo, N. Cyprus, Somaliland...). They still get an id and a row;
    // dropping them would make their pixels unattributable. The synthetic
    // code is only a display placeholder, never a real ISO lookup.
    const code = iso2 ?? synthCode(id);

    index.add(id, toPolys(f.geometry));
    rows.push({
      id,
      iso2: code,
      iso3: isoCode(p.ISO_A3, 3) ?? isoCode(p.ISO_A3_EH, 3),
      // The name column is TEXT, but keep it sane rather than unbounded.
      name: name.slice(0, 120),
      // The client renders real flags as SVGs (flag-icons, keyed off iso2)
      // rather than emoji, since Windows can't display the regional-
      // indicator flag sequences. This column is only a placeholder glyph
      // for entities with no real ISO code; a real one gets "" here.
      flag: iso2 ? "" : WHITE_FLAG,
    });
  }
  return { index, rows };
}

/** Two characters, collision-free across the id range, never a real ISO code. */
function synthCode(id: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return `${alphabet[Math.floor(id / 36) % 36]}${alphabet[id % 36]}`;
}

export function buildWaterIndex(features: GeoJsonFeature[]): PolygonIndex {
  const index = new PolygonIndex();
  for (const f of features) index.add(1, toPolys(f.geometry));
  return index;
}

/** U+1F3F3 U+FE0F — the fallback for entities with no ISO code. A single
 *  ordinary emoji (unlike a flag built from regional-indicator pairs), so
 *  it renders fine on Windows. */
const WHITE_FLAG = String.fromCodePoint(0x1f3f3, 0xfe0f);

export function countriesPresent(): boolean {
  return existsSync(join(DATA_DIR, COUNTRY_FILE));
}

/**
 * Water is optional. Without it the terrain rule degrades to "everything is
 * land", which makes violations impossible rather than wrong - an inert
 * rule, not a misfiring one. Countries are NOT optional: without them the
 * leaderboard has nothing to attribute to.
 */
export function waterPresent(): boolean {
  return existsSync(join(DATA_DIR, WATER_FILE));
}

export function sourcesPresent(): boolean {
  return countriesPresent() && waterPresent();
}

/**
 * Load both indexes for the runtime MIXED fallback.
 *
 * A missing file is a degraded but defined state: MIXED tiles resolve to
 * International Waters and land, which makes the terrain rule inert on
 * coastlines rather than wrong.
 */
export async function loadSources(): Promise<{
  countries: PolygonIndex | null;
  water: PolygonIndex | null;
}> {
  const countries = countriesPresent()
    ? buildCountryIndex(await loadGeoJson(COUNTRY_FILE)).index
    : null;
  const water = waterPresent() ? buildWaterIndex(await loadGeoJson(WATER_FILE)) : null;
  return { countries, water };
}
