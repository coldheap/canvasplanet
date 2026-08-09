/**
 * The export job queue (ROADMAP.md §4.3).
 *
 * Concurrency capped at exactly 1 — a `running` guard exactly like
 * tiles/worker.ts, checked against a DB-backed queue instead of an in-memory
 * one so a restart mid-encode does not lose track of what was queued (the
 * in-flight job itself is simply retried from the top: `runJob` re-derives
 * everything from the row, nothing is carried in process memory between
 * frames except the one frame being piped).
 *
 * `kick()` runs the queue immediately after an insert rather than waiting
 * for the next poll — exports are rare and interactive (someone is watching
 * a progress indicator), unlike the tile-dirty queue which is fed
 * continuously. The poll interval is only the safety net for a `kick()` that
 * arrived while a job was already running.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { EXPORT_FPS, type ExportFormat } from "@worldcanvas/shared";
import { pool } from "../db/pool.js";
import { env } from "../env.js";
import { buildTimelapse } from "../timelapse/build.js";
import { rasterizeFrames } from "./render.js";

let running = false;
let timer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let lastRun: { id: string; ms: number; ok: boolean } | null = null;

/** An encode taking longer than this is assumed wedged, not slow. */
const DRAIN_WATCHDOG_MS = 5 * 60_000;
let startedAt = 0;

const POLL_MS = 5_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;

export function startExportWorker(): void {
  timer = setInterval(() => void tick(), POLL_MS);
  void tick();
  sweepTimer = setInterval(() => {
    void sweepExpiredExports().catch((err) => console.error("[export] sweep failed", err));
  }, SWEEP_INTERVAL_MS);
}

export function stopExportWorker(): void {
  if (timer) clearInterval(timer);
  if (sweepTimer) clearInterval(sweepTimer);
}

/** Called right after a new job is enqueued, so it starts without waiting for the next poll. */
export function kick(): void {
  void tick();
}

export function exportWorkerStats() {
  return { running, lastRun };
}

async function tick(): Promise<void> {
  if (running) {
    if (Date.now() - startedAt > DRAIN_WATCHDOG_MS) {
      console.error(`[export] job wedged for ${((Date.now() - startedAt) / 1000).toFixed(0)}s — resetting`);
      running = false;
    } else {
      return;
    }
  }

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM timelapse_exports WHERE status = 'queued' ORDER BY created_at LIMIT 1`,
  );
  const job = rows[0];
  if (!job) return;

  running = true;
  startedAt = Date.now();
  let ok = false;
  try {
    await runJob(job.id);
    ok = true;
  } catch (err) {
    console.error(`[export] job ${job.id} failed`, err);
    await pool
      .query(`UPDATE timelapse_exports SET status = 'failed', error = $2 WHERE id = $1`, [
        job.id,
        String((err as Error)?.message ?? err).slice(0, 500),
      ])
      .catch(() => {});
  } finally {
    lastRun = { id: job.id, ms: Date.now() - startedAt, ok };
    running = false;
    // Another job may already be waiting — do not idle until the next poll.
    void tick();
  }
}

interface JobRow {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  from_ms: string;
  to_ms: string;
  frames: number;
  format: ExportFormat;
}

async function runJob(id: string): Promise<void> {
  const { rows } = await pool.query<JobRow>(
    `SELECT id, x0, y0, x1, y1, from_ms, to_ms, frames, format
       FROM timelapse_exports WHERE id = $1`,
    [id],
  );
  const job = rows[0];
  if (!job) return;

  await pool.query(`UPDATE timelapse_exports SET status = 'processing' WHERE id = $1`, [id]);

  const data = await buildTimelapse({
    x0: job.x0,
    y0: job.y0,
    x1: job.x1,
    y1: job.y1,
    from: Number(job.from_ms),
    to: Number(job.to_ms),
    frames: job.frames,
  });
  const w = job.x1 - job.x0 + 1;
  const h = job.y1 - job.y0 + 1;

  await mkdir(env.exportOutputDir, { recursive: true });
  const filePath = join(env.exportOutputDir, `${id}.${job.format}`);

  await encode(data, w, h, job.format, filePath);

  const { size } = await stat(filePath);
  const expiresAt = new Date(Date.now() + env.exportExpiryHours * 3600_000);
  await pool.query(
    `UPDATE timelapse_exports
        SET status = 'done', file_path = $2, bytes = $3, completed_at = now(), expires_at = $4
      WHERE id = $1`,
    [id, filePath, size, expiresAt],
  );
}

/** ffmpeg's alpha-aware palette pipeline for a reasonably clean single-pass GIF. */
const GIF_ARGS = ["-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", "-loop", "0"];
/** libx264 requires even dimensions under yuv420p; the pad is a no-op for already-even bboxes. */
const MP4_ARGS = [
  "-vf",
  "pad=ceil(iw/2)*2:ceil(ih/2)*2",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-preset",
  "veryfast",
  "-movflags",
  "+faststart",
];

async function encode(
  data: Awaited<ReturnType<typeof buildTimelapse>>,
  w: number,
  h: number,
  format: ExportFormat,
  outPath: string,
): Promise<void> {
  await rm(outPath, { force: true });

  const args = [
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${w}x${h}`,
    "-r",
    String(EXPORT_FPS),
    "-i",
    "pipe:0",
    ...(format === "gif" ? GIF_ARGS : MP4_ARGS),
    outPath,
  ];

  const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  const exited = once(child, "close");

  try {
    for (const frame of rasterizeFrames(data)) {
      if (!child.stdin.write(frame)) await once(child.stdin, "drain");
      // Rasterizing a frame is synchronous CPU work over w*h pixels; yield
      // between frames so a long encode does not starve the paint path on
      // this single-process server, the same reasoning as tiles/worker.ts.
      await new Promise((resolve) => setImmediate(resolve));
    }
    child.stdin.end();
  } catch (err) {
    child.kill();
    throw err;
  }

  const [code] = (await exited) as [number | null];
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000) || "(no stderr)"}`);
  }
}

/** Deletes expired output files and marks their rows so a repeat request re-encodes. */
export async function sweepExpiredExports(): Promise<number> {
  const { rows } = await pool.query<{ id: string; file_path: string | null }>(
    `SELECT id, file_path FROM timelapse_exports WHERE status = 'done' AND expires_at <= now()`,
  );
  for (const row of rows) {
    if (row.file_path) await rm(row.file_path, { force: true }).catch(() => {});
  }
  if (rows.length > 0) {
    await pool.query(
      `DELETE FROM timelapse_exports WHERE id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
  }
  return rows.length;
}
