import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyAlliancePaint: vi.fn(),
  applyEventPaint: vi.fn(),
  applyPlacement: vi.fn(),
  applyPlayerPaint: vi.fn(),
  beginPlayerPaint: vi.fn(),
  finishEventPaint: vi.fn(),
  getOrCreateSession: vi.fn(),
  getStaff: vi.fn(),
  paint: vi.fn(),
  publishPaint: vi.fn(),
  recordScore: vi.fn(),
  sendToSession: vi.fn(),
}));

vi.mock("../../alliances/store.js", () => ({
  alliances: { applyPaint: mocks.applyAlliancePaint },
}));
vi.mock("../../events/engine.js", () => ({
  events: {
    beginPlayerPaint: mocks.beginPlayerPaint,
    applyPaint: mocks.applyEventPaint,
  },
}));
vi.mock("../../geo/ipCountry.js", () => ({ clientCountryIso: () => "LB" }));
vi.mock("../../leaderboard/store.js", () => ({
  leaderboard: {
    countryIdForIso: () => 1,
    applyPlacement: mocks.applyPlacement,
  },
}));
vi.mock("../../paint/service.js", () => ({ paint: mocks.paint }));
vi.mock("../../players/store.js", () => ({
  players: { applyPaint: mocks.applyPlayerPaint },
}));
vi.mock("../../security/score.js", () => ({ record: mocks.recordScore }));
vi.mock("../../security/turnstile.js", () => ({
  isEnabled: () => false,
  sitekey: () => null,
  verify: vi.fn(),
  markVerified: vi.fn(),
}));
vi.mock("../../session/session.js", () => ({
  clientIp: () => "127.0.0.1",
  getOrCreateSession: mocks.getOrCreateSession,
}));
vi.mock("../../ws/hub.js", () => ({
  hub: {
    publishPaint: mocks.publishPaint,
    sendToSession: mocks.sendToSession,
  },
}));
vi.mock("../staff.js", () => ({ getStaff: mocks.getStaff }));

import { registerPaintRoutes } from "../paint.js";

describe("paint route charge synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginPlayerPaint.mockReturnValue(mocks.finishEventPaint);
    mocks.getOrCreateSession.mockResolvedValue({ id: 17, turnstileOk: true });
    mocks.getStaff.mockResolvedValue(null);
    mocks.paint.mockResolvedValue({
      ok: true,
      changed: true,
      cost: 2,
      bank: 3,
      nextAt: 1_700_000_001_000,
      countryId: 1,
      prevColor: 2,
      prevCountryId: 1,
      allianceId: null,
      prevAllianceId: null,
      userId: 9,
      prevUserId: null,
    });
  });

  it("pushes the committed balance to every socket for the painting session", async () => {
    let handler: ((req: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const app = {
      post: vi.fn((_path, routeHandler) => {
        handler = routeHandler;
      }),
    };
    registerPaintRoutes(app as never);

    const send = vi.fn((body) => body);
    const reply = { send, code: vi.fn(() => reply) };
    await handler?.({ body: { x: 10, y: 20, color: 4 } }, reply);

    expect(mocks.sendToSession).toHaveBeenCalledWith(17, {
      t: "charges",
      bank: 3,
      max: 60,
      nextAt: 1_700_000_001_000,
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ ok: true, bank: 3 }));
  });
});
