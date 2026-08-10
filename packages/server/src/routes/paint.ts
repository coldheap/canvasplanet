import {
  REFUSAL_MESSAGE,
  REFUSAL_STATUS,
  PaintRefusal,
  type PaintError,
  type PaintRequest,
  type PaintResponse,
} from "@worldcanvas/shared";
import type { FastifyInstance } from "fastify";
import { paint } from "../paint/service.js";
import { events } from "../events/engine.js";
import { leaderboard } from "../leaderboard/store.js";
import { alliances } from "../alliances/store.js";
import { players } from "../players/store.js";
import * as score from "../security/score.js";
import * as turnstile from "../security/turnstile.js";
import { clientIp, getOrCreateSession } from "../session/session.js";
import { clientCountryIso } from "../geo/ipCountry.js";
import { getStaff } from "./staff.js";
import { hub } from "../ws/hub.js";

export function registerPaintRoutes(app: FastifyInstance): void {
  app.post<{ Body: PaintRequest }>("/api/paint", async (req, reply) => {
    const session = await getOrCreateSession(req, reply);
    const staff = await getStaff(req);
    const ip = clientIp(req);
    const originCountryId = leaderboard.countryIdForIso(clientCountryIso(req));
    const { x, y, color, turnstileToken } = req.body ?? ({} as PaintRequest);

    // ---- Turnstile gate: once per session, before its first pixel --------
    if (!staff && turnstile.isEnabled() && !session.turnstileOk) {
      if (!turnstileToken) {
        return reply.code(428).send({
          ok: false,
          reason: PaintRefusal.TurnstileRequired,
          message: REFUSAL_MESSAGE[PaintRefusal.TurnstileRequired],
          turnstileSitekey: turnstile.sitekey(),
        } satisfies PaintError);
      }
      if (!(await turnstile.verify(turnstileToken, ip))) {
        return reply.code(428).send({
          ok: false,
          reason: PaintRefusal.TurnstileRequired,
          message: "Verification failed. Please try again.",
          turnstileSitekey: turnstile.sitekey(),
        } satisfies PaintError);
      }
      await turnstile.markVerified(session.id);
      session.turnstileOk = true;
    }

    const result = await paint({
      sessionId: session.id,
      ip,
      originCountryId,
      x,
      y,
      color,
      staff,
    });

    if (!result.ok) {
      return reply.code(REFUSAL_STATUS[result.reason]).send({
        ok: false,
        reason: result.reason,
        message: REFUSAL_MESSAGE[result.reason],
        ...(result.retryAfterMs !== undefined && { retryAfterMs: result.retryAfterMs }),
        ...(result.regionName !== undefined && { regionName: result.regionName }),
      } satisfies PaintError);
    }

    // Commit succeeded — now fan out. Order matters only in that the client
    // that painted should see its own pixel via the same path as everyone
    // else, so there is exactly one code path to get wrong.
    if (result.changed) {
      hub.publishPaint(x, y, color, result.countryId);
      leaderboard.applyPlacement(originCountryId);
      alliances.applyPaint(result.allianceId, result.prevAllianceId);
      players.applyPaint(result.userId, result.prevUserId);
      // ROADMAP.md Phase 7 — a no-op unless this pixel landed inside an active
      // corruption zone. Ordinary paint, own attribution; this only tallies it.
      events.applyPaint(x, y, color, session.id);
      score.record({ sessionId: session.id, x, y, at: Date.now() });
    }

    return reply.send({
      ok: true,
      bank: result.bank,
      nextAt: result.nextAt,
      cost: result.cost,
      countryId: result.countryId,
    } satisfies PaintResponse);
  });
}
