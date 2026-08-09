import { EVENT_WIN_THRESHOLD, EVENT_ZONE_SIZE } from "@worldcanvas/shared";
import { describe, expect, it } from "vitest";
import { ActiveEventState } from "../state.js";

// Exercises only the pure arithmetic — contains/notePaint/corruptionPct/
// result/toDTO never touch the database or the network. The I/O around them
// (zone picking, the bot's writes, the revert on resolve) lives in
// engine.ts and is covered by verify/events.mjs instead.
const BBOX = { x0: 100, y0: 100, x1: 100 + EVENT_ZONE_SIZE - 1, y1: 100 + EVENT_ZONE_SIZE - 1 };
const BOT_COLOR = 0;
const ZONE_AREA = EVENT_ZONE_SIZE * EVENT_ZONE_SIZE;

function fresh(): ActiveEventState {
  return new ActiveEventState(1, BBOX, BOT_COLOR, 0, 60_000, "batch-1");
}

describe("ActiveEventState.contains", () => {
  it("is true for every corner of the zone and false just outside it", () => {
    const ev = fresh();
    expect(ev.contains(BBOX.x0, BBOX.y0)).toBe(true);
    expect(ev.contains(BBOX.x1, BBOX.y1)).toBe(true);
    expect(ev.contains(BBOX.x0 - 1, BBOX.y0)).toBe(false);
    expect(ev.contains(BBOX.x1 + 1, BBOX.y1)).toBe(false);
    expect(ev.contains(BBOX.x0, BBOX.y1 + 1)).toBe(false);
  });
});

describe("ActiveEventState.notePaint / corruptionPct", () => {
  it("starts at zero corruption", () => {
    expect(fresh().corruptionPct()).toBe(0);
  });

  it("counts a bot-coloured pixel as corrupted", () => {
    const ev = fresh();
    ev.notePaint(BBOX.x0, BBOX.y0, BOT_COLOR, null);
    expect(ev.corruptionPct()).toBeCloseTo(1 / ZONE_AREA);
  });

  it("un-corrupts a pixel when a different colour lands on it", () => {
    const ev = fresh();
    ev.notePaint(BBOX.x0, BBOX.y0, BOT_COLOR, null);
    ev.notePaint(BBOX.x0, BBOX.y0, 7, 42);
    expect(ev.corruptionPct()).toBe(0);
  });

  it("re-corrupts a previously-defended pixel if the bot paints over it again", () => {
    const ev = fresh();
    ev.notePaint(BBOX.x0, BBOX.y0, 7, 42); // defended first
    ev.notePaint(BBOX.x0, BBOX.y0, BOT_COLOR, null); // bot re-takes it
    expect(ev.corruptionPct()).toBeCloseTo(1 / ZONE_AREA);
  });

  it("credits any session painting a non-bot colour as a defender, even a still-clean pixel", () => {
    const ev = fresh();
    ev.notePaint(BBOX.x0, BBOX.y0, 5, 7); // never was corrupted
    expect(ev.defenders.has(7)).toBe(true);
    expect(ev.corruptionPct()).toBe(0);
  });

  it("does not credit the bot's own paints (sessionId null) as a defender", () => {
    const ev = fresh();
    ev.notePaint(BBOX.x0, BBOX.y0, BOT_COLOR, null);
    expect(ev.defenders.size).toBe(0);
  });

  it("tracks distinct defenders, not paint counts", () => {
    const ev = fresh();
    ev.notePaint(BBOX.x0, BBOX.y0, 5, 7);
    ev.notePaint(BBOX.x0 + 1, BBOX.y0, 6, 7);
    ev.notePaint(BBOX.x0 + 2, BBOX.y0, 6, 9);
    expect(ev.defenders.size).toBe(2);
  });
});

describe("ActiveEventState.result", () => {
  it("is 'defended' when corruption stays under the threshold", () => {
    const ev = fresh();
    ev.notePaint(BBOX.x0, BBOX.y0, BOT_COLOR, null);
    expect(ev.corruptionPct()).toBeLessThan(EVENT_WIN_THRESHOLD);
    expect(ev.result()).toBe("defended");
  });

  it("is 'corrupted' once coverage reaches the threshold", () => {
    const ev = fresh();
    const need = Math.ceil(ZONE_AREA * EVENT_WIN_THRESHOLD);
    let n = 0;
    for (let x = BBOX.x0; x <= BBOX.x1 && n < need; x++) {
      for (let y = BBOX.y0; y <= BBOX.y1 && n < need; y++) {
        ev.notePaint(x, y, BOT_COLOR, null);
        n++;
      }
    }
    expect(ev.corruptionPct()).toBeGreaterThanOrEqual(EVENT_WIN_THRESHOLD);
    expect(ev.result()).toBe("corrupted");
  });
});

describe("ActiveEventState.toDTO", () => {
  it("reflects live corruption% and defender count", () => {
    const ev = fresh();
    ev.notePaint(BBOX.x0, BBOX.y0, BOT_COLOR, null);
    ev.notePaint(BBOX.x0 + 1, BBOX.y0, 5, 7);
    const dto = ev.toDTO();
    expect(dto).toEqual({
      id: 1,
      bbox: BBOX,
      botColor: BOT_COLOR,
      startedAt: 0,
      endsAt: 60_000,
      corruptionPct: 1 / ZONE_AREA,
      defenders: 1,
    });
  });
});
