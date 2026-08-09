/**
 * Timelapse GIF/MP4 export (ROADMAP.md §4.3).
 *
 * A job queue, not a synchronous render: encoding is capped at concurrency 1
 * (export/queue.ts) so it never competes with the paint path for more than
 * one core at a time. POST enqueues — or, for a repeat request, returns the
 * cached hit instantly and for free, without touching the rate limit. GET
 * polls status; the file route streams the finished output.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  EXPORT_FORMATS,
  EXPORT_RATE_LIMIT_MS,
  TIMELAPSE_MAX_DIM,
  TIMELAPSE_MAX_FRAMES,
  type ExportFormat,
  type ExportStatusResponse,
} from "@worldcanvas/shared";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { kick } from "../export/queue.js";
import { getOrCreateSession } from "../session/session.js";

export function registerExportRoutes(app: FastifyInstance): void {
  app.post<{
    Body: {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      from?: number;
      to?: number;
      frames?: number;
      format?: string;
    };
  }>("/api/export/timelapse", async (req, reply) => {
    const session = await getOrCreateSession(req, reply);
    const b = req.body ?? ({} as never);

    const x0 = Math.min(Number(b.x0), Number(b.x1));
    const x1 = Math.max(Number(b.x0), Number(b.x1));
    const y0 = Math.min(Number(b.y0), Number(b.y1));
    const y1 = Math.max(Number(b.y0), Number(b.y1));
    if (![x0, x1, y0, y1].every(Number.isInteger)) {
      return reply.code(400).send({ error: "x0,y0,x1,y1 must be integers" });
    }
    // Same bound as the timelapse player — the export is derived from
    // exactly the same query, so it cannot be cheaper to encode a bigger area.
    if (x1 - x0 + 1 > TIMELAPSE_MAX_DIM || y1 - y0 + 1 > TIMELAPSE_MAX_DIM) {
      return reply.code(422).send({ error: `area must be at most ${TIMELAPSE_MAX_DIM} pixels per side` });
    }

    const to = b.to ? Number(b.to) : Date.now();
    const from = b.from ? Number(b.from) : to - 7 * 24 * 3600_000;
    if (!(from < to)) return reply.code(400).send({ error: "from must be before to" });
    const requestedFrames = Number(b.frames ?? 100);
    if (!Number.isInteger(requestedFrames) || requestedFrames < 1) {
      return reply.code(400).send({ error: "frames must be a positive integer" });
    }
    const frames = Math.min(requestedFrames, TIMELAPSE_MAX_FRAMES);

    const format = b.format === "mp4" ? "mp4" : "gif";
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
      return reply.code(400).send({ error: `format must be one of ${EXPORT_FORMATS.join(", ")}` });
    }

    const cacheKey = `${x0}:${y0}:${x1}:${y1}:${from}:${to}:${frames}:${format}`;

    // Cache first, unconditionally — a repeat request is free and must not
    // cost the requester their one export for the next 10 minutes.
    const cached = await pool.query<{ id: string }>(
      `SELECT id FROM timelapse_exports
        WHERE cache_key = $1 AND status = 'done' AND expires_at > now()`,
      [cacheKey],
    );
    if (cached.rows[0]) {
      return reply.send({ id: cached.rows[0].id, status: "cached" });
    }

    // Only a genuinely new encode competes for the rate limit.
    const { rows: recent } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM timelapse_exports
        WHERE created_by = $1 AND created_at > now() - ($2 || ' milliseconds')::interval`,
      [session.id, EXPORT_RATE_LIMIT_MS],
    );
    if ((recent[0]?.n ?? 0) >= 1) {
      return reply.code(429).send({ error: "one export per session per 10 minutes" });
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO timelapse_exports (id, cache_key, x0, y0, x1, y1, from_ms, to_ms, frames, format, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, cacheKey, x0, y0, x1, y1, from, to, frames, format satisfies ExportFormat, session.id],
    );
    kick();
    return reply.send({ id, status: "queued" });
  });

  app.get<{ Params: { id: string } }>("/api/export/:id", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send();
    const { rows } = await pool.query<{
      status: "queued" | "processing" | "done" | "failed";
      error: string | null;
      bytes: number | null;
    }>(`SELECT status, error, bytes FROM timelapse_exports WHERE id = $1`, [req.params.id]);
    const row = rows[0];
    if (!row) return reply.code(404).send();

    const body: ExportStatusResponse = {
      id: req.params.id,
      status: row.status,
      error: row.error,
      bytes: row.bytes,
      url: row.status === "done" ? `/api/export/${req.params.id}/file` : null,
    };
    return reply.send(body);
  });

  app.get<{ Params: { id: string } }>("/api/export/:id/file", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send();
    const { rows } = await pool.query<{ file_path: string | null; format: string; status: string }>(
      `SELECT file_path, format, status FROM timelapse_exports
        WHERE id = $1 AND status = 'done' AND expires_at > now()`,
      [req.params.id],
    );
    const row = rows[0];
    if (!row?.file_path) return reply.code(404).send();

    let size: number;
    try {
      size = (await stat(row.file_path)).size;
    } catch {
      return reply.code(404).send();
    }

    reply
      .header("Content-Type", row.format === "gif" ? "image/gif" : "video/mp4")
      .header("Content-Length", size)
      .header("Content-Disposition", `attachment; filename="worldcanvas-${req.params.id}.${row.format}"`)
      // Private: the download URL is unguessable but not access-controlled,
      // same posture as a shared template link.
      .header("Cache-Control", "private, max-age=3600");
    return reply.send(createReadStream(row.file_path));
  });
}
