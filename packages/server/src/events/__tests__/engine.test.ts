/**
 * Failure handling for the three async operations tick() launches as
 * floating promises.
 *
 * These are regression tests for an outage shape rather than feature tests: a
 * single failed transaction inside startEvent/botTick/resolveEvent used to
 * reach Node's unhandledRejection default and kill the process — which is the
 * API, the WebSocket hub and the tile worker at once. So most of what follows
 * asserts what must *not* happen.
 *
 * The engine is a module singleton, so every test re-imports it through
 * vi.resetModules() to get a clean one. env.eventIntervalMs is mocked to 0 so
 * the first tick() tries to start an event instead of waiting ~90 minutes,
 * and Date.now is stubbed rather than faking timers — fake timers would also
 * intercept the promise scheduling these tests are trying to measure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: vi.fn(),
  poolQuery: vi.fn(),
  revert: vi.fn(),
  reloadOwnershipStores: vi.fn(),
  broadcast: vi.fn(),
  publishPaint: vi.fn(),
}));

vi.mock("../../db/pool.js", () => ({ pool: { query: mocks.poolQuery }, tx: mocks.tx }));
vi.mock("../../admin/revert.js", () => ({ revert: mocks.revert }));
vi.mock("../../env.js", () => ({ env: { eventIntervalMs: 0, eventDurationMs: 1_000 } }));
vi.mock("../../geo/index.js", () => ({ geo: { lookup: () => ({ countryId: 1 }) } }));
vi.mock("../../state/policy.js", () => ({
  getProtectedRegions: () => [],
  isFrozen: () => false,
}));
vi.mock("../../ws/hub.js", () => ({
  hub: { broadcast: mocks.broadcast, publishPaint: mocks.publishPaint },
}));
vi.mock("../../alliances/store.js", () => ({ alliances: { applyPaint: vi.fn() } }));
vi.mock("../../leaderboard/store.js", () => ({ leaderboard: { applySystemPaint: vi.fn() } }));
vi.mock("../../players/store.js", () => ({ players: { applyPaint: vi.fn() } }));
vi.mock("../../paint/ownership.js", () => ({
  incrementCumulative: vi.fn(),
  transferHeld: vi.fn(),
  reloadOwnershipStores: mocks.reloadOwnershipStores,
}));

type Engine = (typeof import("../engine.js"))["events"];

const errorLines: string[] = [];
const warnLines: string[] = [];

async function loadEngine(): Promise<Engine> {
  vi.resetModules();
  return (await import("../engine.js")).events;
}

/** Lets a guarded promise settle, then gives Node a real macrotask turn —
 *  which is when an escaped rejection would be reported. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Runs `tick`, then reports anything that escaped as an unhandled rejection. */
async function tickWatchingForUnhandled(events: Engine): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    events.tick();
    await settle();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return escaped;
}

/** Moves the stubbed clock forward, past any backoff window. */
function advance(ms: number): void {
  const target = Date.now() + ms;
  vi.spyOn(Date, "now").mockReturnValue(target);
}

/** A tx() implementation shaped like createAndClearEvent's, clearing no pixels. */
function createdEvent(endsInMs: number) {
  const startedAt = new Date(Date.now());
  const endsAt = new Date(Date.now() + endsInMs);
  return async (run: (c: { query: (...args: unknown[]) => unknown }) => unknown) => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 42, started_at: startedAt, ends_at: endsAt }] })
      .mockResolvedValue({ rows: [] });
    return run({ query });
  };
}

const linesMatching = (lines: string[], needle: string): string[] =>
  lines.filter((line) => line.includes(needle));

/** The UPDATE that claims an event was cleaned up. */
const resolvedWrites = (): unknown[] =>
  mocks.poolQuery.mock.calls.filter((call) => String(call[0]).includes("resolved_at = now()"));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.revert.mockResolvedValue(undefined);
  mocks.reloadOwnershipStores.mockResolvedValue(undefined);
  errorLines.length = 0;
  warnLines.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(String(args[0]));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnLines.push(String(args[0]));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a failing startEvent", () => {
  it("is caught rather than escaping as an unhandled rejection", async () => {
    const events = await loadEngine();
    mocks.tx.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const escaped = await tickWatchingForUnhandled(events);

    expect(escaped).toEqual([]);
    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(linesMatching(errorLines, "[events] startEvent failed")).toHaveLength(1);
  });

  it("backs off instead of retrying on every 1 Hz tick", async () => {
    const events = await loadEngine();
    mocks.tx.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await tickWatchingForUnhandled(events);
    expect(mocks.tx).toHaveBeenCalledTimes(1);

    // Further ticks land inside the backoff window and must not retry.
    for (let i = 0; i < 5; i++) {
      events.tick();
      await settle();
    }
    expect(mocks.tx).toHaveBeenCalledTimes(1);

    // Past the window it tries again — this is a backoff, not a permanent stop.
    advance(120_000);
    await tickWatchingForUnhandled(events);
    expect(mocks.tx).toHaveBeenCalledTimes(2);
  });

  it("collapses a sustained outage into far fewer log lines than attempts", async () => {
    const events = await loadEngine();
    mocks.tx.mockRejectedValue(new Error("connection terminated unexpectedly"));

    // Ten attempts spread past each backoff window but inside one log window.
    for (let i = 0; i < 10; i++) {
      advance(3_000);
      await tickWatchingForUnhandled(events);
    }

    const failures = linesMatching(errorLines, "startEvent failed");
    expect(mocks.tx.mock.calls.length).toBeGreaterThan(1);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.length).toBeLessThan(mocks.tx.mock.calls.length);
  });

  it("reports recovery once the database comes back", async () => {
    const events = await loadEngine();
    mocks.tx.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    await tickWatchingForUnhandled(events);

    mocks.tx.mockImplementation(createdEvent(60_000));
    advance(120_000);
    await tickWatchingForUnhandled(events);

    expect(linesMatching(warnLines, "startEvent recovered after 1 consecutive failure(s)")).toHaveLength(1);
    expect(events.current()).not.toBeNull();
  });
});

describe("a failing resolveEvent", () => {
  /** Drives the engine to an active event, then moves past its deadline. */
  async function activeThenExpired(): Promise<Engine> {
    const events = await loadEngine();
    mocks.tx.mockImplementation(createdEvent(1_000));
    await tickWatchingForUnhandled(events);
    expect(events.current()).not.toBeNull();
    advance(10_000);
    return events;
  }

  it("is caught rather than escaping as an unhandled rejection", async () => {
    const events = await activeThenExpired();
    mocks.revert.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const escaped = await tickWatchingForUnhandled(events);

    expect(escaped).toEqual([]);
    expect(linesMatching(errorLines, "[events] resolveEvent failed")).toHaveLength(1);
  });

  it("leaves the event unresolved so recoverOnBoot can clean it up", async () => {
    const events = await activeThenExpired();
    mocks.revert.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await tickWatchingForUnhandled(events);

    // The zone was never reverted, so the row must not claim it was. Marking
    // it resolved here would strand corruption pixels on the canvas with no
    // record left for the next boot to find.
    expect(resolvedWrites()).toEqual([]);
    // Still active, so the retry has something left to resolve.
    expect(events.current()).not.toBeNull();
  });

  it("keeps retrying and completes once the database recovers", async () => {
    const events = await activeThenExpired();
    mocks.revert.mockRejectedValue(new Error("connection terminated unexpectedly"));
    await tickWatchingForUnhandled(events);
    expect(events.current()).not.toBeNull();

    mocks.revert.mockResolvedValue(undefined);
    advance(120_000);
    await tickWatchingForUnhandled(events);
    // resolveEvent sleeps REVERT_MOPUP_DELAY_MS between its two revert passes.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(events.current()).toBeNull();
    expect(resolvedWrites()).toHaveLength(1);
  }, 15_000);
});

describe("a failing botTick", () => {
  it("does not reject the promise resolveEvent awaits before reverting", async () => {
    const events = await loadEngine();
    mocks.tx.mockImplementationOnce(createdEvent(60_000));
    await tickWatchingForUnhandled(events);
    expect(events.current()).not.toBeNull();

    // This tick is inside the event window, so it launches a bot stroke.
    mocks.tx.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const escaped = await tickWatchingForUnhandled(events);

    expect(escaped).toEqual([]);
    expect(linesMatching(errorLines, "[events] botTick failed")).toHaveLength(1);

    // A failed bot stroke must not stop the resolve path from reverting the
    // zone: the botTickPromise it awaits has to fulfil, not reject.
    advance(120_000);
    await tickWatchingForUnhandled(events);
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(mocks.revert).toHaveBeenCalled();
    expect(events.current()).toBeNull();
  }, 15_000);
});
