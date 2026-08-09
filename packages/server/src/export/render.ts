/**
 * Rasterize a TimelapseResponse into one RGBA frame buffer per bucket — the
 * server-side equivalent of TimelapsePanel.tsx's seek()/draw(), so an export
 * looks exactly like what the player showed (same palette, same terrain
 * fallback for unpainted pixels).
 *
 * A generator, not an array: export/queue.ts pulls one frame at a time and
 * pipes it straight to ffmpeg's stdin, so this never holds more than one
 * frame in memory regardless of frame count.
 */
import { DEFAULT_TERRAIN_COLOR, PALETTE_RGB, type Terrain, type TimelapseResponse } from "@worldcanvas/shared";

/** Sentinel for "nothing painted here yet" — same as the client and the template tools. */
const EMPTY = 255;

export function decodeTerrain(base64: string, n: number): Uint8Array {
  const bin = Buffer.from(base64, "base64");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bin[i >> 3]! >> (i & 7)) & 1;
  return out;
}

export function* rasterizeFrames(data: TimelapseResponse): Generator<Buffer> {
  const w = data.bbox.x1 - data.bbox.x0 + 1;
  const h = data.bbox.y1 - data.bbox.y0 + 1;
  const terrain = decodeTerrain(data.terrain, w * h);
  const state = new Uint8Array(w * h).fill(EMPTY);
  for (const [x, y, c] of data.base) {
    state[(y - data.bbox.y0) * w + (x - data.bbox.x0)] = c;
  }

  for (const f of data.frames) {
    for (const [x, y, c] of f.p) {
      state[(y - data.bbox.y0) * w + (x - data.bbox.x0)] = c;
    }

    const buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < state.length; i++) {
      const idx = state[i]!;
      const rgb = idx === EMPTY ? PALETTE_RGB[DEFAULT_TERRAIN_COLOR[terrain[i] as Terrain]] : PALETTE_RGB[idx];
      if (!rgb) continue;
      buf[i * 4] = rgb[0]!;
      buf[i * 4 + 1] = rgb[1]!;
      buf[i * 4 + 2] = rgb[2]!;
      buf[i * 4 + 3] = 255;
    }
    yield buf;
  }
}
