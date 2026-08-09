/**
 * The 32-color palette, and the land/water family split that the terrain
 * rule keys off.
 *
 * Indices 0..26 are the LAND family, 27..31 are the WATER family.
 * There is deliberately no neutral family — see PLAN.md §13.1. If black
 * outlines at sea prove too expensive in practice, add `Family.Neutral`
 * here and nothing else in the codebase needs to change.
 */

export const enum Family {
  Land = 0,
  Water = 1,
}

export interface Swatch {
  /** Palette index. This is what is stored in the database. */
  i: number;
  hex: string;
  name: string;
  family: Family;
}

export const PALETTE: readonly Swatch[] = [
  // --- greys & neutrals (LAND family) ---
  { i: 0, hex: "#000000", name: "Black", family: Family.Land },
  { i: 1, hex: "#3C3C3C", name: "Dark Grey", family: Family.Land },
  { i: 2, hex: "#787878", name: "Grey", family: Family.Land },
  { i: 3, hex: "#D2D2D2", name: "Light Grey", family: Family.Land },
  { i: 4, hex: "#FFFFFF", name: "White", family: Family.Land },
  // --- reds / pinks ---
  { i: 5, hex: "#600018", name: "Deep Red", family: Family.Land },
  { i: 6, hex: "#A50E1E", name: "Dark Red", family: Family.Land },
  { i: 7, hex: "#ED1C24", name: "Red", family: Family.Land },
  { i: 8, hex: "#FA8072", name: "Salmon", family: Family.Land },
  { i: 9, hex: "#E45C9C", name: "Pink", family: Family.Land },
  { i: 10, hex: "#7A1F5A", name: "Plum", family: Family.Land },
  // --- oranges / browns / skin ---
  { i: 11, hex: "#FF7F27", name: "Orange", family: Family.Land },
  { i: 12, hex: "#F6AA09", name: "Amber", family: Family.Land },
  { i: 13, hex: "#F9DD3B", name: "Yellow", family: Family.Land },
  { i: 14, hex: "#FFFABC", name: "Cream", family: Family.Land },
  { i: 15, hex: "#6D482F", name: "Brown", family: Family.Land },
  { i: 16, hex: "#9C6926", name: "Tan", family: Family.Land },
  { i: 17, hex: "#D18078", name: "Skin Mid", family: Family.Land },
  { i: 18, hex: "#FFC5A5", name: "Skin Light", family: Family.Land },
  // --- greens ---
  { i: 19, hex: "#0E4B28", name: "Deep Green", family: Family.Land },
  { i: 20, hex: "#13892B", name: "Green", family: Family.Land },
  { i: 21, hex: "#5BC44A", name: "Light Green", family: Family.Land },
  { i: 22, hex: "#B4E24A", name: "Lime", family: Family.Land },
  // --- purples / magentas ---
  { i: 23, hex: "#4A2B7D", name: "Deep Purple", family: Family.Land },
  { i: 24, hex: "#7C34C4", name: "Purple", family: Family.Land },
  { i: 25, hex: "#B85CE0", name: "Lilac", family: Family.Land },
  { i: 26, hex: "#E4A5F0", name: "Orchid", family: Family.Land },
  // --- WATER family (5) ---
  { i: 27, hex: "#0A1F5C", name: "Abyss", family: Family.Water },
  { i: 28, hex: "#1E3A8A", name: "Navy", family: Family.Water },
  { i: 29, hex: "#2563EB", name: "Blue", family: Family.Water },
  { i: 30, hex: "#60A5FA", name: "Sky", family: Family.Water },
  { i: 31, hex: "#7EE8E8", name: "Shallow", family: Family.Water },
] as const;

export const PALETTE_SIZE = PALETTE.length; // 32

/** Precomputed family lookup — hot path, called on every paint. */
const FAMILY: readonly Family[] = PALETTE.map((s) => s.family);

export function familyOf(colorIndex: number): Family {
  return FAMILY[colorIndex] ?? Family.Land;
}

export function isValidColor(i: unknown): i is number {
  return Number.isInteger(i) && (i as number) >= 0 && (i as number) < PALETTE_SIZE;
}

/** Packed RGB triples, for the tile renderer's blit loop. */
export const PALETTE_RGB: readonly [number, number, number][] = PALETTE.map((s) => [
  parseInt(s.hex.slice(1, 3), 16),
  parseInt(s.hex.slice(3, 5), 16),
  parseInt(s.hex.slice(5, 7), 16),
]);

/**
 * Nearest palette index for an arbitrary RGB colour, used by the template
 * converter and the admin image stamp.
 *
 * Distance is computed in Oklab rather than RGB: RGB distance systematically
 * mismatches on saturated colours, which is exactly what pixel art is made
 * of. Cheap enough to run per-pixel on a 512×512 image.
 */
export function nearestPaletteIndex(r: number, g: number, b: number): number {
  const [L, a, bb] = srgbToOklab(r, g, b);
  return nearestInOklab(L, a, bb);
}

/**
 * The palette in Oklab, computed once.
 *
 * The original version converted every palette entry on every lookup — 32
 * cube roots per pixel. On a 512x512 image that is 8.4 million cube roots for
 * a result that never changes.
 */
export const PALETTE_OKLAB: readonly [number, number, number][] = PALETTE_RGB.map(([r, g, b]) =>
  srgbToOklab(r, g, b),
);

/** Nearest palette entry to a colour already in Oklab. */
export function nearestInOklab(L: number, a: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < PALETTE_OKLAB.length; i++) {
    const p = PALETTE_OKLAB[i]!;
    const d = (L - p[0]) ** 2 + (a - p[1]) ** 2 + (b - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export { srgbToOklab };

/** Sentinel for "leave this pixel alone" in template and stamp data. */
export const TRANSPARENT_INDEX = 255;

export type DitherMode = "none" | "floyd";

/**
 * Quantize an RGBA image to the palette.
 *
 * Error diffusion runs in Oklab, the same space the nearest-neighbour search
 * uses. Diffusing in sRGB instead is the common mistake: the error terms are
 * then in a non-perceptual space and the dithering visibly favours whichever
 * channel happens to be large, which on a 32-colour palette looks like
 * colour noise rather than texture.
 *
 * Returns one palette index per pixel, TRANSPARENT_INDEX where the source
 * was transparent.
 */
export function quantizeToPalette(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  mode: DitherMode = "none",
): Uint8Array {
  const out = new Uint8Array(width * height).fill(TRANSPARENT_INDEX);

  if (mode === "none") {
    for (let i = 0; i < out.length; i++) {
      const o = i * 4;
      // Anything meaningfully transparent stays unpainted, rather than
      // becoming whatever colour sits behind an alpha of 3.
      if (rgba[o + 3]! < 128) continue;
      out[i] = nearestPaletteIndex(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
    }
    return out;
  }

  // Floyd–Steinberg. Work on a mutable Oklab copy so accumulated error is
  // carried into neighbours before they are quantized.
  const lab = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const [L, a, b] = srgbToOklab(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
    lab[i * 3] = L;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }

  const spread = (i: number, eL: number, ea: number, eb: number, f: number) => {
    lab[i * 3]! += eL * f;
    lab[i * 3 + 1]! += ea * f;
    lab[i * 3 + 2]! += eb * f;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (rgba[i * 4 + 3]! < 128) continue;

      const L = lab[i * 3]!;
      const a = lab[i * 3 + 1]!;
      const b = lab[i * 3 + 2]!;
      const idx = nearestInOklab(L, a, b);
      out[i] = idx;

      const p = PALETTE_OKLAB[idx]!;
      const eL = L - p[0];
      const ea = a - p[1];
      const eb = b - p[2];

      // 7/16 right, 3/16 down-left, 5/16 down, 1/16 down-right.
      if (x + 1 < width) spread(i + 1, eL, ea, eb, 7 / 16);
      if (y + 1 < height) {
        if (x > 0) spread(i + width - 1, eL, ea, eb, 3 / 16);
        spread(i + width, eL, ea, eb, 5 / 16);
        if (x + 1 < width) spread(i + width + 1, eL, ea, eb, 1 / 16);
      }
    }
  }

  return out;
}

function srgbToOklab(r8: number, g8: number, b8: number): [number, number, number] {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = f(r8);
  const g = f(g8);
  const b = f(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
