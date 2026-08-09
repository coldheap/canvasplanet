-- Persisted health snapshots for the public status page's uptime history.
--
-- Sampled from inside the app itself (see src/status/history.ts) rather than
-- by an external prober. That is a real limitation, not just a shortcut: a
-- full process crash writes no bad sample at all, so an outage that kills
-- the process shows as a gap in the strip, not as "down" time. Point an
-- external uptime monitor at status.<domain> for anything that needs to page
-- someone — this table is the "what did our own numbers look like" record,
-- not a substitute for one.

BEGIN;

CREATE TABLE status_history (
  id               BIGSERIAL PRIMARY KEY,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok               BOOLEAN NOT NULL,
  db_ok            BOOLEAN NOT NULL,
  db_latency_ms    REAL NOT NULL,
  paints_per_sec   INTEGER NOT NULL,
  tile_queue_depth INTEGER NOT NULL,
  ws_degraded      INTEGER NOT NULL
);

-- Every read is "the last N days", so a BRIN on the append-ordered timestamp
-- is the same trade made for pixel_events: ~100x smaller than a btree, and
-- block-level pruning is all a date-range scan needs.
CREATE INDEX status_history_checked_brin ON status_history USING BRIN (checked_at);

COMMIT;
