import { ERASED, Terrain } from "@canvasplanet/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db/pool.js", () => ({ pool: { query } }));
vi.mock("../../geo/index.js", () => ({ geo: { lookup: () => ({ terrain: Terrain.Water }) } }));

import { buildTimelapse } from "../build.js";

describe("buildTimelapse", () => {
  beforeEach(() => query.mockReset());

  it("loads the real state at from, including pixels untouched in the window", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { x: 10, y: 10, color: 4, t: null, event_id: null, is_base: true },
        { x: 11, y: 10, color: ERASED, t: null, event_id: null, is_base: true },
        { x: 12, y: 10, color: 5, t: new Date(1_500), event_id: 8, is_base: false },
      ],
    });

    const result = await buildTimelapse({ x0: 10, y0: 10, x1: 12, y1: 10, from: 1_000, to: 2_000, frames: 2 });
    expect(result.base).toEqual([[10, 10, 4]]);
    expect(result.frames.flatMap((frame) => frame.p)).toEqual([[12, 10, 5]]);
  });

  it("rejects invalid frame counts before querying", async () => {
    await expect(
      buildTimelapse({ x0: 0, y0: 0, x1: 0, y1: 0, from: 1, to: 2, frames: Number.NaN }),
    ).rejects.toThrow("frames must be a positive integer");
    expect(query).not.toHaveBeenCalled();
  });
});
