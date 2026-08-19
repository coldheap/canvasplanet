import { PNG } from "pngjs";
import { ERASED, PALETTE_RGB, TILE_SIZE, pixelIndexInTile } from "@canvasplanet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/pool.js", () => ({ pool: { query } }));
vi.mock("../cache.js", () => ({ peekTile: vi.fn() }));
vi.mock("../../metrics.js", () => ({
  tileQueryTime: { measure: (run: () => unknown) => run() },
  tileEncodeTime: { measureSync: (run: () => unknown) => run() },
}));

import { renderHistoryTile } from "../renderer.js";

describe("renderHistoryTile", () => {
  beforeEach(() => query.mockReset());

  it("draws the latest visible historical state and leaves erasures transparent", async () => {
    query.mockResolvedValue({
      rows: [
        { x: 257, y: 514, color: 0 },
        { x: 258, y: 515, color: ERASED },
      ],
    });

    const image = PNG.sync.read(await renderHistoryTile(1, 2, 1_700_000_000_000));
    const painted = pixelIndexInTile(257, 514) * 4;
    const erased = pixelIndexInTile(258, 515) * 4;

    expect([...image.data.subarray(painted, painted + 4)]).toEqual([...PALETTE_RGB[0]!, 255]);
    expect([...image.data.subarray(erased, erased + 4)]).toEqual([0, 0, 0, 0]);
    expect(image.width).toBe(TILE_SIZE);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("created_at <="), [1, 2, 1_700_000_000_000]);
  });
});
