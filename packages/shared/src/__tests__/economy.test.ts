import { describe, expect, it } from "vitest";
import { CHARGE_MAX, CHARGE_REGEN_MS, IP_BUDGET_MAX, IP_BUDGET_REFILL_MS } from "../config.js";
import {
  Terrain,
  canAfford,
  isViolation,
  msUntilNextCharge,
  paintCost,
  refillBucket,
  regenerate,
  spend,
  takeToken,
} from "../economy.js";
import { Family, PALETTE, familyOf } from "../palette.js";

const BLUE = 29; // water family
const GREEN = 20; // land family
const NAVY = 28; // water family
const BLACK = 0; // land family

describe("palette families", () => {
  it("tags exactly 5 water colours out of 32", () => {
    expect(PALETTE).toHaveLength(32);
    expect(PALETTE.filter((s) => s.family === Family.Water)).toHaveLength(5);
  });

  it("puts the water family at the end of the palette", () => {
    for (let i = 27; i < 32; i++) expect(familyOf(i)).toBe(Family.Water);
    for (let i = 0; i < 27; i++) expect(familyOf(i)).toBe(Family.Land);
  });
});

describe("isViolation", () => {
  it("flags water colours on land and land colours on water", () => {
    expect(isViolation(BLUE, Terrain.Land)).toBe(true);
    expect(isViolation(GREEN, Terrain.Water)).toBe(true);
  });
  it("permits matching terrain", () => {
    expect(isViolation(BLUE, Terrain.Water)).toBe(false);
    expect(isViolation(GREEN, Terrain.Land)).toBe(false);
  });
});

describe("paintCost — the six cases from PLAN.md §2", () => {
  it("1: empty pixel, terrain-correct colour", () => {
    expect(paintCost({ currentColor: null, newColor: GREEN, terrain: Terrain.Land })).toEqual({
      cost: 1,
      reason: "base",
    });
  });

  it("2: empty pixel, violating colour", () => {
    expect(paintCost({ currentColor: null, newColor: BLUE, terrain: Terrain.Land })).toEqual({
      cost: 2,
      reason: "violation",
    });
  });

  it("2: painted pixel, terrain-correct colour (overpaint)", () => {
    expect(paintCost({ currentColor: GREEN, newColor: BLACK, terrain: Terrain.Land })).toEqual({
      cost: 2,
      reason: "overpaint",
    });
  });

  it("2: painted pixel + violating colour — modifiers do NOT stack", () => {
    const r = paintCost({ currentColor: GREEN, newColor: BLUE, terrain: Terrain.Land });
    expect(r.cost).toBe(2); // not 3, not 4
    expect(r.reason).toBe("violation");
  });

  it("1: restoring a sunk land pixel is cheap even though it is an overpaint", () => {
    expect(paintCost({ currentColor: BLUE, newColor: GREEN, terrain: Terrain.Land })).toEqual({
      cost: 1,
      reason: "restore",
    });
  });

  it("1: restoring a filled-in sea pixel is equally cheap", () => {
    expect(paintCost({ currentColor: GREEN, newColor: BLUE, terrain: Terrain.Water })).toEqual({
      cost: 1,
      reason: "restore",
    });
  });

  it("2: repainting one violating colour with another gets no discount", () => {
    expect(paintCost({ currentColor: BLUE, newColor: NAVY, terrain: Terrain.Land }).cost).toBe(2);
  });

  it("never costs more than 2 or less than 1, for any combination", () => {
    for (let cur = -1; cur < 32; cur++) {
      for (let next = 0; next < 32; next++) {
        for (const terrain of [Terrain.Land, Terrain.Water]) {
          const { cost } = paintCost({
            currentColor: cur < 0 ? null : cur,
            newColor: next,
            terrain,
          });
          expect(cost).toBeGreaterThanOrEqual(1);
          expect(cost).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it("makes sinking land cost twice what healing it does", () => {
    const sink = paintCost({ currentColor: GREEN, newColor: BLUE, terrain: Terrain.Land }).cost;
    const heal = paintCost({ currentColor: BLUE, newColor: GREEN, terrain: Terrain.Land }).cost;
    expect(sink).toBe(2 * heal);
  });
});

describe("charge bank", () => {
  const T0 = 1_700_000_000_000;

  it("regenerates one charge per CHARGE_REGEN_MS", () => {
    const bank = { charges: 0, updatedAt: T0 };
    expect(regenerate(bank, T0 + CHARGE_REGEN_MS - 1).charges).toBe(0);
    expect(regenerate(bank, T0 + CHARGE_REGEN_MS).charges).toBe(1);
    expect(regenerate(bank, T0 + CHARGE_REGEN_MS * 3).charges).toBe(3);
  });

  it("caps at 30", () => {
    const bank = { charges: 0, updatedAt: T0 };
    expect(regenerate(bank, T0 + CHARGE_REGEN_MS * 1000).charges).toBe(CHARGE_MAX);
  });

  it("does not discard partial progress on a read", () => {
    // 1.5 periods elapsed = 1 charge + half a period of progress. Reading
    // must not reset that partial progress.
    const bank = { charges: 0, updatedAt: T0 };
    const half = CHARGE_REGEN_MS / 2;
    const after = regenerate(bank, T0 + CHARGE_REGEN_MS + half);
    expect(after.charges).toBe(1);
    expect(msUntilNextCharge(after, T0 + CHARGE_REGEN_MS + half)).toBe(half);
    // another half-period and the second charge lands
    expect(regenerate(after, T0 + CHARGE_REGEN_MS * 2 + half).charges).toBe(2);
  });

  it("reports null time-to-next when full", () => {
    expect(msUntilNextCharge({ charges: CHARGE_MAX, updatedAt: T0 }, T0)).toBeNull();
  });

  it("starts the accrual clock at the moment a full bank is first spent", () => {
    const full = { charges: CHARGE_MAX, updatedAt: T0 - 999_999 };
    const after = spend(full, 1, T0)!;
    expect(after.charges).toBe(CHARGE_MAX - 1);
    // Must be a fresh 30s, not an instant refill from the stale timestamp.
    expect(msUntilNextCharge(after, T0)).toBe(CHARGE_REGEN_MS);
  });

  it("refuses a spend it cannot afford, without mutating", () => {
    const bank = { charges: 1, updatedAt: T0 };
    expect(spend(bank, 2, T0)).toBeNull();
    expect(bank.charges).toBe(1);
    expect(canAfford(bank, 2, T0)).toBe(false);
    expect(canAfford(bank, 1, T0)).toBe(true);
  });

  it("cannot be double-spent by two reads at the same instant", () => {
    // The server serialises this with FOR UPDATE; this asserts the pure
    // function is at least not the source of the bug.
    const bank = { charges: 1, updatedAt: T0 };
    const a = spend(bank, 1, T0);
    const b = spend(a!, 1, T0);
    expect(a!.charges).toBe(0);
    expect(b).toBeNull();
  });

  it("lets a full bank place 30 pixels in a burst and no more", () => {
    let bank = { charges: CHARGE_MAX, updatedAt: T0 };
    let placed = 0;
    for (let i = 0; i < 50; i++) {
      const next = spend(bank, 1, T0);
      if (!next) break;
      bank = next;
      placed++;
    }
    expect(placed).toBe(30);
  });
});

describe("IP token bucket", () => {
  const T0 = 1_700_000_000_000;

  it("gives an honest solo user exactly their regen rate", () => {
    // IP_BUDGET_MAX tokens/hr refilling at 1/IP_BUDGET_REFILL_MS == the
    // charge bank's own hourly regen rate. Never a false positive.
    expect((3600_000 / IP_BUDGET_REFILL_MS) | 0).toBe(IP_BUDGET_MAX);
  });

  it("caps a cookie-wipe farm at IP_BUDGET_MAX paints per hour", () => {
    let b = { tokens: IP_BUDGET_MAX, updatedAt: T0 };
    let paints = 0;
    // simulate 200 fresh sessions each trying to burn 30 charges instantly
    for (let s = 0; s < 200; s++) {
      for (let p = 0; p < 30; p++) {
        const next = takeToken(b, 1, T0, IP_BUDGET_MAX, IP_BUDGET_REFILL_MS);
        if (!next) break;
        b = next;
        paints++;
      }
    }
    expect(paints).toBe(IP_BUDGET_MAX); // not the full 6000 attempted
  });

  it("refills fractionally over time", () => {
    const b = { tokens: 0, updatedAt: T0 };
    expect(
      refillBucket(b, T0 + IP_BUDGET_REFILL_MS / 2, IP_BUDGET_MAX, IP_BUDGET_REFILL_MS).tokens,
    ).toBeCloseTo(0.5);
    expect(refillBucket(b, T0 + 3600_000, IP_BUDGET_MAX, IP_BUDGET_REFILL_MS).tokens).toBe(
      IP_BUDGET_MAX,
    );
  });
});
