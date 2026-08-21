import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let useStore: typeof import("./store.js").useStore;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: vi.fn() } },
  });
  ({ useStore } = await import("./store.js"));
});

beforeEach(() => {
  useStore.setState({
    bank: 60,
    nextAt: null,
    settledBank: 60,
    settledNextAt: null,
    bankVersion: 0,
    bankSnapshotAt: 0,
    reserved: 0,
  });
});

describe("charge reservations", () => {
  it("does not visually refund later reservations during a mobile burst", () => {
    for (let i = 0; i < 15; i++) useStore.getState().reserveCharges(2);
    expect(useStore.getState()).toMatchObject({ bank: 30, reserved: 30 });

    // The first response only knows about its own spend. It must not replace
    // the UI's 15 already-reserved deductions with its much higher balance.
    useStore.getState().syncBank(58, 2_000, 1, 1_000);
    useStore.getState().releaseCharges(2);
    expect(useStore.getState()).toMatchObject({ bank: 30, reserved: 28 });

    // Once the newest snapshot arrives and every request settles, its exact
    // server balance becomes visible.
    useStore.getState().syncBank(30, 3_000, 15, 2_000);
    for (let i = 0; i < 14; i++) useStore.getState().releaseCharges(2);
    expect(useStore.getState()).toMatchObject({ bank: 30, reserved: 0 });

    // A delayed old response cannot restore the spent charges afterward.
    useStore.getState().syncBank(56, 4_000, 2, 3_000);
    expect(useStore.getState().bank).toBe(30);
  });

  it("rolls back one reservation when a request is refused", () => {
    useStore.getState().reserveCharges(4);
    expect(useStore.getState().bank).toBe(56);

    // A refusal spends nothing server-side, so releasing the reservation is
    // the whole correction — no resync required.
    useStore.getState().releaseCharges(4);
    expect(useStore.getState()).toMatchObject({ bank: 60, reserved: 0 });
  });

  /**
   * The bug this model exists to prevent: reserving less than a pixel really
   * costs made the bar show charges the server would refuse to honour.
   */
  it("drains at the true rate when paints cost more than the base price", () => {
    for (let i = 0; i < 15; i++) useStore.getState().reserveCharges(4);
    expect(useStore.getState().bank).toBe(0);

    // Every response lands; the server's balance agrees with what was shown.
    useStore.getState().syncBank(0, 1_000, 15, 500);
    for (let i = 0; i < 15; i++) useStore.getState().releaseCharges(4);
    expect(useStore.getState()).toMatchObject({ bank: 0, reserved: 0 });
  });

  it("keeps the visible bank inside 0..max", () => {
    useStore.getState().reserveCharges(1_000);
    expect(useStore.getState().bank).toBe(0);

    useStore.getState().releaseCharges(1_000);
    useStore.getState().setBank(999, null);
    expect(useStore.getState().bank).toBe(useStore.getState().max);
  });
});
