/**
 * The read-only features that make the canvas feel like a place with a past:
 * pixel inspector, leaderboard, country pages, timelapse, templates.
 */

import { randomUUID } from "node:crypto";
import {
  TEMPLATE_MAX_DIM,
  TIMELAPSE_MAX_DIM,
  TIMELAPSE_MAX_FRAMES,
  pixelCenterLatLng,
  type PixelInfo,
  isValidColor,
} from "@worldcanvas/shared";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { geo } from "../geo/index.js";
import { subdivisions } from "../geo/subdivisions.js";
import { leaderboard } from "../leaderboard/store.js";
import { getOrCreateSession } from "../session/session.js";
import { buildTimelapse } from "../timelapse/build.js";

/**
 * Regional breakdown for a country page, from a capped sample of held
 * pixels rather than every one — for a heavily-painted country that could
 * be millions of point-in-polygon tests on a request a human is waiting on.
 * The cap trades precision for a bounded response time; the cache means
 * that cost is paid once per country per window, not once per page view.
 */
const SUBDIVISION_SAMPLE_CAP = 50_000;
const SUBDIVISION_CACHE_TTL_MS = 10 * 60_000;
const subdivisionCache = new Map<string, { at: number; rows: Array<{ name: string; cumulative: number }> }>();

async function subdivisionBreakdown(
  countryId: number,
  countryIso2: string,
): Promise<Array<{ name: string; cumulative: number }>> {
  if (!subdivisions.loaded) return [];
  const cached = subdivisionCache.get(countryIso2);
  if (cached && Date.now() - cached.at < SUBDIVISION_CACHE_TTL_MS) return cached.rows;

  const { rows } = await pool.query<{ x: number; y: number }>(
    `SELECT x, y FROM pixels WHERE country_id = $1 LIMIT $2`,
    [countryId, SUBDIVISION_SAMPLE_CAP],
  );

  const counts = new Map<string, number>();
  for (const r of rows) {
    const { lat, lng } = pixelCenterLatLng({ x: r.x, y: r.y });
    const hit = subdivisions.lookup(lng, lat);
    if (hit && hit.countryIso2 === countryIso2) {
      counts.set(hit.name, (counts.get(hit.name) ?? 0) + 1);
    }
  }

  const result = [...counts.entries()]
    .map(([name, cumulative]) => ({ name, cumulative }))
    .sort((a, b) => b.cumulative - a.cumulative)
    .slice(0, 8);

  subdivisionCache.set(countryIso2, { at: Date.now(), rows: result });
  return result;
}

/** Sentinel in template data for "leave this pixel alone". */
const TRANSPARENT = 255;

export function registerExploreRoutes(app: FastifyInstance): void {
  // ---- pixel inspector: click any pixel to see who and when ----------------
  app.get<{ Params: { x: string; y: string } }>("/api/pixel/:x/:y", async (req, reply) => {
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    const { rows } = await pool.query<{
      color: number;
      country_id: number;
      painted_at: Date;
      paint_count: number;
    }>(`SELECT color, country_id, painted_at, paint_count FROM pixels WHERE x=$1 AND y=$2`, [x, y]);

    const { countryId, terrain } = geo.lookup(x, y);
    const r = rows[0];
    const info: PixelInfo = {
      x,
      y,
      color: r?.color ?? null,
      terrain,
      countryId: r?.country_id ?? countryId,
      paintedAt: r?.painted_at.toISOString() ?? null,
      paintCount: r?.paint_count ?? 0,
    };
    // Session and IP are deliberately NOT here — that is /api/admin/inspect.
    return reply.send(info);
  });

  // ---- bulk region read ---------------------------------------------------
  /**
   * Every painted colour in a rectangle, as one byte per pixel.
   *
   * The template overlay needs to know which of its pixels are already done,
   * which can cover up to TEMPLATE_MAX_DIM² lookups. Doing that as individual
   * /api/pixel calls
   * would be absurd, and reading it back out of the rendered tiles means
   * matching RGB to palette indices and inheriting whatever the tile worker
   * has not caught up on yet. One capped query returning raw indices is both
   * cheaper and exact.
   */
  app.get<{ Querystring: { x0: string; y0: string; x1: string; y1: string } }>(
    "/api/region",
    async (req, reply) => {
      const x0 = Math.min(Number(req.query.x0), Number(req.query.x1));
      const x1 = Math.max(Number(req.query.x0), Number(req.query.x1));
      const y0 = Math.min(Number(req.query.y0), Number(req.query.y1));
      const y1 = Math.max(Number(req.query.y0), Number(req.query.y1));
      if (![x0, x1, y0, y1].every(Number.isInteger)) {
        return reply.code(400).send({ error: "x0,y0,x1,y1 must be integers" });
      }

      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      // Same cap as a template, for the same reason: this is the largest
      // area anything is allowed to ask about in one request.
      if (w > TEMPLATE_MAX_DIM || h > TEMPLATE_MAX_DIM) {
        return reply
          .code(422)
          .send({ error: `region must be at most ${TEMPLATE_MAX_DIM} pixels per side` });
      }

      const { rows } = await pool.query<{ x: number; y: number; color: number }>(
        `SELECT x, y, color FROM pixels
          WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4`,
        [x0, x1, y0, y1],
      );

      const data = Buffer.alloc(w * h, TRANSPARENT);
      for (const r of rows) data[(r.y - y0) * w + (r.x - x0)] = r.color;

      return reply.send({
        x0,
        y0,
        w,
        h,
        painted: rows.length,
        data: data.toString("base64"),
      });
    },
  );

  // ---- leaderboard --------------------------------------------------------
  app.get("/api/leaderboard", async (_req, reply) =>
    reply.send({ world: leaderboard.worldTotal(), rows: leaderboard.rows() }),
  );

  // ---- country pages ------------------------------------------------------
  app.get<{ Params: { iso: string } }>("/api/country/:iso", async (req, reply) => {
    const { rows } = await pool.query<{ id: number; name: string; flag: string }>(
      `SELECT id, name, flag FROM countries WHERE iso_a2 = upper($1)`,
      [req.params.iso],
    );
    const country = rows[0];
    if (!country) return reply.code(404).send();

    const stat = leaderboard.rows().find((r) => r[0] === country.id);

    // Busiest area in the last day, as a z6-ish bucket the client can fly to.
    // Bucketing in SQL avoids pulling a day of events into the process.
    const { rows: hot } = await pool.query<{ bx: number; by: number; n: number }>(
      `SELECT (x >> 14) AS bx, (y >> 14) AS by, count(*)::int AS n
         FROM pixel_events
        WHERE country_id = $1 AND created_at > now() - interval '24 hours'
        GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`,
      [country.id],
    );
    const h = hot[0];

    return reply.send({
      ...country,
      cumulative: stat?.[1] ?? 0,
      held: stat?.[2] ?? 0,
      rank: leaderboard.rankOf(country.id),
      // Centre of the busiest bucket.
      hotspot: h ? { x: (h.bx << 14) + 8192, y: (h.by << 14) + 8192, paints: h.n } : null,
      subdivisions: await subdivisionBreakdown(country.id, req.params.iso.toUpperCase()),
    });
  });

  // ---- timelapse ----------------------------------------------------------
  app.get<{
    Querystring: {
      x0: string;
      y0: string;
      x1: string;
      y1: string;
      from?: string;
      to?: string;
      frames?: string;
    };
  }>("/api/timelapse", async (req, reply) => {
    const x0 = Math.min(Number(req.query.x0), Number(req.query.x1));
    const x1 = Math.max(Number(req.query.x0), Number(req.query.x1));
    const y0 = Math.min(Number(req.query.y0), Number(req.query.y1));
    const y1 = Math.max(Number(req.query.y0), Number(req.query.y1));

    if (![x0, x1, y0, y1].every(Number.isInteger)) {
      return reply.code(400).send({ error: "x0,y0,x1,y1 must be integers" });
    }
    // The bound is what keeps this the most shareable feature rather than the
    // most expensive query in the app.
    if (x1 - x0 + 1 > TIMELAPSE_MAX_DIM || y1 - y0 + 1 > TIMELAPSE_MAX_DIM) {
      return reply
        .code(422)
        .send({ error: `area must be at most ${TIMELAPSE_MAX_DIM} pixels per side` });
    }

    const to = req.query.to ? Number(req.query.to) : Date.now();
    const from = req.query.from ? Number(req.query.from) : to - 7 * 24 * 3600_000;
    if (!(from < to)) return reply.code(400).send({ error: "from must be before to" });
    const requestedFrames = Number(req.query.frames ?? 100);
    if (!Number.isInteger(requestedFrames) || requestedFrames < 1) {
      return reply.code(400).send({ error: "frames must be a positive integer" });
    }
    const frames = Math.min(requestedFrames, TIMELAPSE_MAX_FRAMES);

    const body = await buildTimelapse({ x0, y0, x1, y1, from, to, frames });
    return reply.send(body);
  });

  // ---- shareable templates ------------------------------------------------
  app.post<{ Body: { x: number; y: number; w: number; h: number; data: string } }>(
    "/api/templates",
    async (req, reply) => {
      const session = await getOrCreateSession(req, reply);
      const { x, y, w, h, data } = req.body ?? ({} as never);

      if (![x, y, w, h].every(Number.isInteger) || w <= 0 || h <= 0) {
        return reply.code(400).send({ error: "x,y,w,h must be integers; w,h positive" });
      }
      if (w > TEMPLATE_MAX_DIM || h > TEMPLATE_MAX_DIM) {
        return reply
          .code(422)
          .send({ error: `template must be at most ${TEMPLATE_MAX_DIM} pixels per side` });
      }
      if (typeof data !== "string") {
        return reply.code(400).send({ error: "data must be base64 palette indices" });
      }

      const buf = Buffer.from(data, "base64");
      if (buf.length !== w * h) {
        return reply.code(400).send({ error: `data must decode to exactly ${w * h} bytes` });
      }
      // Store only the quantized indices, never the source image: it keeps
      // the payload tiny and means the server never holds user-uploaded
      // image bytes at all.
      for (const b of buf) {
        if (b !== TRANSPARENT && !isValidColor(b)) {
          return reply.code(400).send({ error: `invalid palette index ${b}` });
        }
      }

      // Templates are a moderation surface, so rate limit publishing hard.
      const { rows: recent } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM templates
          WHERE created_by = $1 AND created_at > now() - interval '1 hour'`,
        [session.id],
      );
      if ((recent[0]?.n ?? 0) >= 10) {
        return reply.code(429).send({ error: "too many templates published from this session" });
      }

      const id = randomUUID();
      await pool.query(
        `INSERT INTO templates (id, x, y, w, h, data, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, x, y, w, h, buf, session.id],
      );
      // Unlisted by design: link only, no directory, no search.
      return reply.send({ id, url: `/t/${id}` });
    },
  );

  app.get<{ Params: { id: string } }>("/api/templates/:id", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send();
    const { rows } = await pool.query(
      `UPDATE templates SET views = views + 1
        WHERE id = $1 AND removed_at IS NULL
        RETURNING id, x, y, w, h, encode(data, 'base64') AS data`,
      [req.params.id],
    );
    if (!rows[0]) return reply.code(404).send();
    return reply.send(rows[0]);
  });

  /**
   * Report a template.
   *
   * Templates are unlisted — link only, no directory, no search — so nobody
   * stumbles across a bad one. But that also means nobody finds it to report
   * it except the people it was shared with, which is exactly who this is
   * for. One report per session, so a single person cannot inflate the count
   * that decides what a moderator looks at first.
   */
  app.post<{ Params: { id: string } }>("/api/templates/:id/report", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send();
    const session = await getOrCreateSession(req, reply);
    const { rowCount } = await pool.query(
      `INSERT INTO template_reports (template_id, session_id) VALUES ($1, $2)
       ON CONFLICT (template_id, session_id) DO NOTHING`,
      [req.params.id, session.id],
    );
    // Report or duplicate, the answer is the same: never confirm whether a
    // given template exists to someone guessing ids.
    return reply.send({ ok: true, counted: rowCount === 1 });
  });
}
