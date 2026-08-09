/**
 * A 5x7 bitmap font, used to render the landmark's pixel text.
 *
 * Deliberately hand-encoded rather than pulled from a font library: the
 * landmark is drawn at 1 pixel per glyph pixel, so anything with antialiasing
 * or hinting would produce grey fringes that do not exist in a 32-colour
 * palette. Each glyph is 7 rows of 5 bits, MSB-left.
 */

const GLYPHS: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  ".": [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
  "-": [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
  "/": [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  ":": [0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100, 0b00000],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** One blank column between glyphs. */
export const ADVANCE = GLYPH_W + 1;

export function textWidth(text: string, scale = 1): number {
  return text.length === 0 ? 0 : (text.length * ADVANCE - 1) * scale;
}

export function textHeight(scale = 1): number {
  return GLYPH_H * scale;
}

export interface Painted {
  x: number;
  y: number;
}

/**
 * Rasterise text, calling `plot` for every lit pixel. Unknown characters are
 * skipped rather than substituted, so a typo shows as a gap instead of a
 * wrong glyph nobody notices.
 */
export function drawText(
  text: string,
  originX: number,
  originY: number,
  scale: number,
  plot: (x: number, y: number) => void,
): void {
  const upper = text.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const glyph = GLYPHS[upper[i]!];
    if (!glyph) continue;
    const gx = originX + i * ADVANCE * scale;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row]!;
      for (let col = 0; col < GLYPH_W; col++) {
        if ((bits >> (GLYPH_W - 1 - col)) & 1) {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              plot(gx + col * scale + sx, originY + row * scale + sy);
            }
          }
        }
      }
    }
  }
}

/** Hollow rectangle, `thickness` pixels wide, drawn inside the bounds. */
export function drawRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  plot: (x: number, y: number) => void,
): void {
  for (let t = 0; t < thickness; t++) {
    for (let x = x0 + t; x <= x1 - t; x++) {
      plot(x, y0 + t);
      plot(x, y1 - t);
    }
    for (let y = y0 + t; y <= y1 - t; y++) {
      plot(x0 + t, y);
      plot(x1 - t, y);
    }
  }
}
