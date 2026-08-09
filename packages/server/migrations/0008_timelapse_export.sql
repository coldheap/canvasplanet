-- Timelapse GIF/MP4 export (ROADMAP.md §4.3) — a job queue in front of the
-- ffmpeg encode, because unlike every other read in this app an export is
-- not free: a 512x512x200-frame encode is 2-10s of one core, competing
-- directly with the tile worker and the paint transaction on a single-VPS
-- deploy. Concurrency is capped at exactly one in-process (export/queue.ts);
-- this table is the queue itself and the cache.
--
-- One row per requested export. `cache_key` is the parameters that fully
-- determine the output (bbox, time range, frame count, format) so a repeat
-- request finds the existing row and skips the encode entirely — the
-- "cache by (bbox, from, to)" requirement.

BEGIN;

CREATE TYPE export_status AS ENUM ('queued', 'processing', 'done', 'failed');

CREATE TABLE timelapse_exports (
  id           UUID PRIMARY KEY,
  cache_key    TEXT NOT NULL,
  x0           INTEGER NOT NULL,
  y0           INTEGER NOT NULL,
  x1           INTEGER NOT NULL,
  y1           INTEGER NOT NULL,
  from_ms      BIGINT NOT NULL,
  to_ms        BIGINT NOT NULL,
  frames       SMALLINT NOT NULL,
  format       TEXT NOT NULL,          -- 'gif' | 'mp4', see EXPORT_FORMATS
  status       export_status NOT NULL DEFAULT 'queued',
  error        TEXT,
  file_path    TEXT,
  bytes        INTEGER,
  created_by   BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ             -- set on completion; NULL until then
);

-- The queue drain: oldest queued job first.
CREATE INDEX timelapse_exports_queue_idx ON timelapse_exports (created_at) WHERE status = 'queued';
-- Cache lookup: a matching completed, unexpired job.
CREATE INDEX timelapse_exports_cache_idx ON timelapse_exports (cache_key) WHERE status = 'done';
-- Rate limit: how many a session has started recently. Only counts real
-- encodes — a cache hit never inserts a row, so it never counts here either.
CREATE INDEX timelapse_exports_session_idx ON timelapse_exports (created_by, created_at DESC);
-- Expiry sweep.
CREATE INDEX timelapse_exports_expiry_idx ON timelapse_exports (expires_at) WHERE status = 'done';

COMMIT;
