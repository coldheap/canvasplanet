/**
 * Country subdivisions (Natural Earth admin_1) — a country-page enrichment,
 * not a paint-time attribution.
 *
 * Deliberately NOT baked into the per-tile grid the way countries and
 * terrain are: that machinery exists because country attribution runs on
 * every single paint and has to answer in well under a millisecond. A
 * subdivision breakdown is read once, lazily, when someone opens a country
 * page — so it is computed the cheap way instead, straight from `pixels`
 * plus this in-memory polygon index, and cached for a few minutes. No new
 * column on `pixels` or `pixel_events`, no change to the paint transaction.
 * See explore.ts for the read side.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PolygonIndex } from "./polygonIndex.js";
import { DATA_DIR, isoCode, loadGeoJson, str, toPolys } from "./source.js";

export const SUBDIVISION_FILE = "ne_10m_admin_1_states_provinces.geojson";

export interface SubdivisionRow {
  id: number;
  countryIso2: string;
  name: string;
}

export function subdivisionsPresent(): boolean {
  return existsSync(join(DATA_DIR, SUBDIVISION_FILE));
}

class SubdivisionIndex {
  private index: PolygonIndex | null = null;
  private rows: SubdivisionRow[] = [];

  async load(): Promise<void> {
    if (!subdivisionsPresent()) return; // optional source — see fetch-geodata.ts

    const features = await loadGeoJson(SUBDIVISION_FILE);
    const index = new PolygonIndex();
    const rows: SubdivisionRow[] = [];

    let nextId = 1;
    for (const f of features) {
      // Entries with no usable ISO_A2 (a handful of disputed territories)
      // cannot be tied back to a row in `countries`, so they are skipped
      // rather than shown detached from any country.
      const countryIso2 = isoCode(f.properties.iso_a2, 2);
      if (!countryIso2) continue;
      const name = str(f.properties.name) ?? str(f.properties.woe_name);
      if (!name) continue;

      const id = nextId++;
      index.add(id, toPolys(f.geometry));
      rows.push({ id, countryIso2, name: name.slice(0, 120) });
    }

    this.index = index;
    this.rows = rows;
    console.log(`[geo] loaded ${rows.length} subdivisions`);
  }

  get loaded(): boolean {
    return this.index !== null;
  }

  /** Which subdivision contains this point, or null (ocean, no coverage, no match). */
  lookup(lon: number, lat: number): SubdivisionRow | null {
    if (!this.index) return null;
    const id = this.index.lookup(lon, lat);
    return id === null ? null : (this.rows[id - 1] ?? null);
  }
}

export const subdivisions = new SubdivisionIndex();
