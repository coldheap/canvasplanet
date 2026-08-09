/**
 * An R-tree over a GeoJSON feature collection, with the two queries the
 * canvas needs: "which feature contains this point" and "is this rectangle
 * uniformly inside one feature".
 *
 * Used twice with different data:
 *   - Natural Earth 1:10m admin_0 -> country attribution
 *   - OSM simplified water polygons -> the land/sea terrain test
 */

import RBush from "rbush";
import {
  Coverage,
  type Poly,
  type Rect,
  classifyRect,
  pointInPolygon,
  ringBbox,
} from "@worldcanvas/shared";

export interface Feature {
  /** Stable id written into the baked index. */
  id: number;
  poly: Poly;
  bbox: Rect;
}

interface Entry extends Rect {
  feature: Feature;
}

export class PolygonIndex {
  private tree = new RBush<Entry>();
  // Buffered until the first query instead of inserted one-by-one. RBush's
  // insert() is O(log n) per call; its load() bulk-packs the whole batch in
  // one STR build, which is the difference between the ~1.7s synchronous
  // stall loadSources() caused at boot (measured directly: see the §2.5
  // ROADMAP follow-up) and a fraction of that. Deferred rather than eager so
  // callers that only ever add-then-query (every call site today) pay for
  // exactly one build.
  private pending: Entry[] = [];
  readonly features: Feature[] = [];

  /**
   * A GeoJSON MultiPolygon becomes several independent entries rather than
   * one. Indexing Indonesia as a single bbox would make its bounding box
   * span a third of the planet and defeat the R-tree entirely.
   */
  add(id: number, polys: Poly[]): void {
    for (const poly of polys) {
      const outer = poly[0];
      if (!outer || outer.length < 4) continue;
      const feature: Feature = { id, poly, bbox: ringBbox(outer) };
      this.features.push(feature);
      this.pending.push({ ...feature.bbox, feature });
    }
  }

  private ensureBuilt(): void {
    if (this.pending.length === 0) return;
    this.tree.load(this.pending);
    this.pending = [];
  }

  get size(): number {
    return this.features.length;
  }

  /** Features whose bbox overlaps the rectangle. Cheap pre-filter. */
  candidates(r: Rect): Feature[] {
    this.ensureBuilt();
    return this.tree.search(r).map((e) => e.feature);
  }

  /** Which feature contains this point, or null. */
  lookup(lon: number, lat: number): number | null {
    this.ensureBuilt();
    const hits = this.tree.search({ minX: lon, minY: lat, maxX: lon, maxY: lat });
    for (const { feature } of hits) {
      if (pointInPolygon(feature.poly, lon, lat)) return feature.id;
    }
    return null;
  }

  /**
   * Classify a rectangle for the bake.
   *
   *   { uniform: id }    every point in the rect belongs to that feature
   *   { uniform: null }  every point is outside every feature
   *   { mixed: true }    a boundary passes through
   *
   * With no candidates at all the answer is immediate, which is what makes
   * the quadtree descent fast: most of the planet is open ocean and resolves
   * in a single R-tree miss.
   */
  classify(r: Rect): { uniform: number | null } | { mixed: true } {
    const hits = this.candidates(r);
    if (hits.length === 0) return { uniform: null };

    let full: number | null = null;
    for (const f of hits) {
      const c = classifyRect(f.poly, r);
      if (c === Coverage.Partial) return { mixed: true };
      if (c === Coverage.Full) {
        // Two features both fully covering the rect means overlapping source
        // geometry (it happens in Natural Earth around disputed areas).
        // Treat it as mixed so the runtime resolves it per-point instead of
        // silently picking whichever was indexed first.
        if (full !== null && full !== f.id) return { mixed: true };
        full = f.id;
      }
    }
    return { uniform: full };
  }
}
