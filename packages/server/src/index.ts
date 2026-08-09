/**
 * Worldcanvas server entrypoint.
 *
 * One process holds the API, the WebSocket hub and the tile worker. That is
 * deliberate: the hub is in-memory and the tile cache is on local disk, and
 * both assume a single instance. Scaling out is a v2 decision that touches
 * exactly two files (ws/hub.ts and tiles/cache.ts).
 */

import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import {
  CHARGE_MAX,
  effectiveRegenMs,
  msUntilNextCharge,
  regenerate,
} from "@worldcanvas/shared";
import Fastify from "fastify";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { env } from "./env.js";
import { events } from "./events/engine.js";
import { geo } from "./geo/index.js";
import { loadSources } from "./geo/source.js";
import { subdivisions } from "./geo/subdivisions.js";
import { loadAsnDatabase } from "./security/asn.js";
import { leaderboard } from "./leaderboard/store.js";
import { alliances } from "./alliances/store.js";
import { players } from "./players/store.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAllianceRoutes } from "./routes/alliances.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBasemapRoutes } from "./routes/basemap.js";
import { registerBootstrapRoutes } from "./routes/bootstrap.js";
import { registerExploreRoutes } from "./routes/explore.js";
import { registerExportRoutes } from "./routes/export.js";
import { registerPaintRoutes } from "./routes/paint.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerTileRoutes } from "./routes/tiles.js";
import { findSession } from "./session/session.js";
import { startStatusHistory, stopStatusHistory } from "./status/history.js";
import { loadPolicy } from "./state/policy.js";
import { startExportWorker, stopExportWorker } from "./export/queue.js";
import { startTileWorker, stopTileWorker } from "./tiles/worker.js";
import { hub } from "./ws/hub.js";
import { parseClientMessage } from "./ws/protocol.js";

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: env.isProd ? "info" : "debug" },
    // Caddy and Cloudflare sit in front; the real client IP comes from
    // CF-Connecting-IP (see session/clientIp), not from a trusted XFF chain.
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // ---- boot order matters -------------------------------------------------
  await migrate();
  await loadPolicy();
  await leaderboard.load();
  await alliances.load();
  await players.load();
  // Reverts anything a prior crash left mid-event before anyone can see it —
  // see events/engine.ts's recoverOnBoot() doc comment.
  await events.recoverOnBoot();
  try {
    await geo.load();
    // The source polygons resolve MIXED tiles (coastlines, borders) at
    // paint time. Without them those pixels fall back to a documented
    // default rather than failing, so this is a warning and not fatal.
    const sources = await loadSources();
    geo.attachSources(sources.countries, sources.water);
    if (!sources.countries) {
      app.log.warn("[geo] source GeoJSON missing — MIXED tiles will use defaults");
    }
  } catch (err) {
    // The thin slice (M1) runs before the geo bake exists. Degrade loudly
    // rather than refusing to boot: everything becomes International Waters
    // and land, which makes the terrain rule a no-op rather than a wrong
    // answer.
    app.log.warn({ err }, "[geo] index unavailable — run `pnpm geo:bake`");
  }
  // Optional country-page enrichment; never blocks boot. See geo/subdivisions.ts.
  await subdivisions.load().catch((err) => app.log.warn({ err }, "[geo] subdivisions load failed"));

  // Anti-bot layer 2. Optional: without the dataset, ASN gating is off and
  // the other layers still apply.
  await loadAsnDatabase().catch((err) => app.log.warn({ err }, "[asn] load failed"));

  registerBootstrapRoutes(app);
  registerPaintRoutes(app);
  registerTileRoutes(app);
  registerBasemapRoutes(app);
  registerExploreRoutes(app);
  registerExportRoutes(app);
  registerReportRoutes(app);
  registerAllianceRoutes(app);
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerStatusRoutes(app);

  // ---- websocket ----------------------------------------------------------
  app.get("/ws", { websocket: true }, (socket, req) => {
    // IMPORTANT: this handler is deliberately NOT async, and the message
    // listener is attached before anything awaits.
    //
    // @fastify/websocket completes the handshake before invoking us, so the
    // client's `open` fires immediately and it sends its subscription right
    // away. Resolving the session first (a database round trip) would leave
    // a window with no "message" listener attached — and `ws` drops those
    // events rather than buffering them. The subscription would vanish and
    // that client would silently never receive a pixel again.
    let conn: ReturnType<typeof hub.add> | null = null;
    let closed = false;
    const queued: string[] = [];

    const handle = (text: string): void => {
      const msg = parseClientMessage(text);
      if (!msg) {
        socket.close(1008, "invalid message");
        return;
      }
      if (msg.t === "sub" && conn) hub.subscribe(conn, msg.tiles);
      else if (msg.t === "ping") socket.send(JSON.stringify({ t: "pong" }));
    };

    socket.on("message", (raw) => {
      const text = raw.toString();
      // Hold anything that arrives before the session resolves. Bounded, so
      // a client that floods during the handshake cannot grow this forever.
      if (!conn) {
        if (queued.length < 16) queued.push(text);
        return;
      }
      handle(text);
    });

    socket.on("close", () => {
      closed = true;
      if (conn) hub.remove(conn);
    });
    socket.on("error", () => {
      closed = true;
      if (conn) hub.remove(conn);
    });

    // `?ro=1` — an anonymous read-only subscriber (the embeddable widget,
    // ROADMAP.md §4.2). It can never paint (that is a separate HTTP route,
    // gated on its own session) and never receives a personal `charges`
    // push, so it has no need for a session at all — which sidesteps a real
    // problem: the session cookie is SameSite=Lax, and a Lax cookie is never
    // attached to requests from inside a *cross-origin* iframe (the whole
    // point of an embed), so cookie-based auth simply cannot work there.
    // Pixel frames, the leaderboard and the pulse tick are public broadcasts
    // regardless of who is connected, so an unauthenticated read-only
    // socket costs the app nothing that a session-backed one didn't already.
    const readOnly = (req.query as Record<string, string | undefined> | undefined)?.ro === "1";

    void (async () => {
      // A Set-Cookie on a 101 upgrade response is not reliably honoured, so
      // this never mints a session — it requires one. The client calls
      // /api/bootstrap first, which is where the cookie is issued.
      const session = readOnly ? null : await findSession(req);
      if (!session && !readOnly) {
        socket.close(4001, "no session — call /api/bootstrap first");
        return;
      }
      if (closed) return; // client gave up during the lookup

      conn = hub.add(socket, session?.id ?? null);

      if (session) {
        // Send the current bank immediately so a reconnecting tab is
        // accurate before the user touches anything.
        const now = Date.now();
        const regenMs = effectiveRegenMs(session.eventBonusUntil, now);
        const bank = regenerate(
          { charges: session.charges, updatedAt: session.chargesUpdatedAt },
          now,
          CHARGE_MAX,
          regenMs,
        );
        const nextMs = msUntilNextCharge(bank, now, CHARGE_MAX, regenMs);
        hub.sendToSession(session.id, {
          t: "charges",
          bank: bank.charges,
          max: CHARGE_MAX,
          nextAt: nextMs === null ? null : now + nextMs,
        });
      }

      // Now drain whatever arrived during the lookup.
      for (const text of queued) handle(text);
      queued.length = 0;
    })();
  });

  hub.start([
    () => leaderboard.tick(),
    () => alliances.tick(),
    () => players.tick(),
    () => events.tick(),
  ]);
  startTileWorker();
  startStatusHistory();
  startExportWorker();

  // In production the process sits behind Caddy inside a container, so it
  // must bind every interface. In development it must NOT: binding 0.0.0.0
  // on a machine with a public IP puts the admin API on the internet with no
  // Cloudflare, no WAF and a dev SESSION_SECRET in front of it.
  const host = env.isProd ? "0.0.0.0" : "127.0.0.1";
  await app.listen({ port: env.port, host });
  app.log.info(`worldcanvas listening on ${host}:${env.port}`);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} — shutting down`);
    hub.stop();
    stopTileWorker();
    stopStatusHistory();
    stopExportWorker();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
