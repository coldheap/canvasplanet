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
    pendingPaints: 0,
  });
});

describe("charge snapshot reconciliation", () => {
  it("does not visually refund later optimistic spends during a mobile burst", () => {
    for (let i = 0; i < 15; i++) useStore.getState().spendOptimistic(2);
    expect(useStore.getState()).toMatchObject({ bank: 30, pendingPaints: 15 });

    // The first response only knows about its own spend. It must not replace
    // the UI's 15 already-pending deductions with its much higher balance.
    useStore.getState().syncBank(58, 2_000, 1, 1_000);
    useStore.getState().settlePaint();
    expect(useStore.getState()).toMatchObject({ bank: 30, pendingPaints: 14 });

    // Once the newest snapshot arrives and every request settles, its exact
    // server balance becomes visible.
    useStore.getState().syncBank(30, 3_000, 15, 2_000);
    for (let i = 0; i < 14; i++) useStore.getState().settlePaint();
    expect(useStore.getState()).toMatchObject({ bank: 30, pendingPaints: 0 });

    // A delayed old response cannot restore the spent charges afterward.
    useStore.getState().syncBank(56, 4_000, 2, 3_000);
    expect(useStore.getState().bank).toBe(30);
  });

  it("rolls back one optimistic deduction when a request settles without a new snapshot", () => {
    useStore.getState().spendOptimistic(2);
    expect(useStore.getState().bank).toBe(58);

    useStore.getState().settlePaint();
    expect(useStore.getState()).toMatchObject({ bank: 60, pendingPaints: 0 });
  });
});
