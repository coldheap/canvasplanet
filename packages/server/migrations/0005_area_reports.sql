-- The missing *input* side of moderation (ROADMAP.md §3.1). The tooling to
-- act on vandalism already existed (revert, ban); this is how a moderator
-- hears about it in the first place instead of only finding it by looking.

BEGIN;

CREATE TABLE area_reports (
  id          BIGSERIAL PRIMARY KEY,
  x0          INTEGER NOT NULL,
  y0          INTEGER NOT NULL,
  x1          INTEGER NOT NULL,
  y1          INTEGER NOT NULL,
  reason      TEXT,
  session_id  BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  ip          INET,
  status      TEXT NOT NULL DEFAULT 'open',
  resolved_by INTEGER REFERENCES staff(id),
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (x1 >= x0 AND y1 >= y0),
  CHECK (status IN ('open', 'dismissed', 'reverted'))
);

-- The queue reads "open, oldest first" almost every time; everything else
-- (history, "who reported this") is rare enough to not need its own index.
CREATE INDEX area_reports_queue_idx ON area_reports (status, created_at);

COMMIT;
