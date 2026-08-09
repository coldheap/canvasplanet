/**
 * Planar geometry for the geo bake and the runtime lookup.
 *
 * Lives in `shared` because the bake (server script) and the lookup (server
 * runtime) must agree exactly — a tile classified "wholly land" at bake time
 * and tested differently at runtime would silently charge people the wrong
 * amount forever.
 *
 * Everything works in lon/lat degrees. That is not equal-area, but every
 * operation here is a containment test, and containment is preserved under
 * the Mercator transform — so the distortion does not matter.
 */

export type Ring = ReadonlyArray<readonly [number, number]>;
/** GeoJSON Polygon: outer ring first, then holes. */
export type Poly = ReadonlyArray<Ring>;
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function ringBbox(ring: Ring): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Crossing-number point-in-ring test.
 *
 * The `(yi > y) !== (yj > y)` form uses a half-open rule on the vertical
 * span, which is what makes a point lying exactly on a shared vertex count
 * for exactly one of the two edges. Without that, points on horizontal
 * boundaries between adjacent countries get attributed to both or neither.
 */
export function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(poly: Poly, x: number, y: number): boolean {
  const outer = poly[0];
  if (!outer || !pointInRing(outer, x, y)) return false;
  for (let h = 1; h < poly.length; h++) {
    if (pointInRing(poly[h]!, x, y)) return false;
  }
  return true;
}

/** Do segments p1-p2 and p3-p4 properly cross? */
export function segmentsIntersect(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (d === 0) return false; // parallel or collinear
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Does any edge of the polygon cross the rectangle's boundary? */
export function polygonCrossesRect(poly: Poly, r: Rect): boolean {
  const corners: Array<readonly [number, number]> = [
    [r.minX, r.minY],
    [r.maxX, r.minY],
    [r.maxX, r.maxY],
    [r.minX, r.maxY],
  ];
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!;
      const b = ring[i]!;
      // Cheap reject: an edge whose own bbox misses the rect cannot cross it.
      if (
        Math.max(a[0], b[0]) < r.minX ||
        Math.min(a[0], b[0]) > r.maxX ||
        Math.max(a[1], b[1]) < r.minY ||
        Math.min(a[1], b[1]) > r.maxY
      ) {
        continue;
      }
      for (let c = 0; c < 4; c++) {
        if (segmentsIntersect(a, b, corners[c]!, corners[(c + 1) % 4]!)) return true;
      }
    }
  }
  return false;
}

export const enum Coverage {
  /** The rectangle lies entirely outside the polygon. */
  None = 0,
  /** The rectangle lies entirely inside the polygon. */
  Full = 1,
  /** The polygon's boundary passes through the rectangle. */
  Partial = 2,
}

/**
 * Classify a rectangle against a polygon — the core of the bake.
 *
 * Testing the four corners is NOT sufficient and is the classic bug here: a
 * narrow inlet or a small island entirely inside the rectangle leaves all
 * four corners on the same side while the rectangle is genuinely mixed. So
 * the boundary-crossing test comes first, and only when no edge crosses can
 * a single interior point decide the whole rectangle.
 */
export function classifyRect(poly: Poly, r: Rect): Coverage {
  if (polygonCrossesRect(poly, r)) return Coverage.Partial;

  // Nothing crosses the rectangle's edges — but a ring can still be entirely
  // *swallowed* by it, which puts both sides of that boundary inside the
  // rectangle without any crossing. This applies to holes as much as to the
  // outer ring: a lake wholly within one tile makes that tile mixed, and
  // checking only the outer ring would call it uniformly land.
  for (const ring of poly) {
    if (ring.length > 0 && rectContainsRect(r, ringBbox(ring))) return Coverage.Partial;
  }

  // Now the rectangle really is uniformly inside or outside, so a single
  // interior point settles it.
  const cx = (r.minX + r.maxX) / 2;
  const cy = (r.minY + r.maxY) / 2;
  return pointInPolygon(poly, cx, cy) ? Coverage.Full : Coverage.None;
}
