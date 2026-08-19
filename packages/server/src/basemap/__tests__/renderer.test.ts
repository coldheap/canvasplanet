import { PNG } from "pngjs";
import { TILE_SIZE } from "@canvasplanet/shared";
import { describe, expect, it } from "vitest";
import { TerrainBits } from "../../geo/bake.js";
import { LAND_RGB, WATER_RGB, encodeTerrainTile } from "../renderer.js";

describe("pixel basemap renderer", () => {
  it("encodes uniform terrain as a full opaque tile", () => {
    const image = PNG.sync.read(encodeTerrainTile(TerrainBits.Land));
    expect(image.width).toBe(TILE_SIZE);
    expect(image.height).toBe(TILE_SIZE);
    expect([...image.data.subarray(0, 4)]).toEqual([...LAND_RGB, 255]);
    expect([...image.data.subarray(-4)]).toEqual([...LAND_RGB, 255]);
  });

  it("preserves each individual terrain pixel at its exact tile offset", () => {
    const mask = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(TerrainBits.Land);
    const x = 73;
    const y = 149;
    mask[y * TILE_SIZE + x] = TerrainBits.Water;

    const image = PNG.sync.read(encodeTerrainTile(mask));
    const water = (y * TILE_SIZE + x) * 4;
    const neighbour = (y * TILE_SIZE + x + 1) * 4;
    expect([...image.data.subarray(water, water + 4)]).toEqual([...WATER_RGB, 255]);
    expect([...image.data.subarray(neighbour, neighbour + 4)]).toEqual([...LAND_RGB, 255]);
  });
});
