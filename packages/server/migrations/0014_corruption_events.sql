-- Corruption event (ROADMAP.md Phase 7) — recurring vs-server event.
--
-- corruption_events is the ONLY permanent trace an event ever happened: the
-- zone itself is fully reverted (win or lose) via admin/revert.ts, so this
-- row is a summary, not a record of the pixels. events/engine.ts is the
-- in-memory authority for a currently-running event (bbox, live corruption
-- %, defenders) the same way state/policy.ts is for regions/freeze; this
-- table only gets written on start and on resolve.
--
-- sessions.event_bonus_until is the reward: a temporary charge-rate bonus
-- (see economy.ts's effectiveRegenMs) for anyone who landed at least one
-- defending paint in a winning event.

BEGIN;

CREATE TABLE corruption_events (
  id              SERIAL PRIMARY KEY,
  x0              INT NOT NULL,
  y0              INT NOT NULL,
  x1              INT NOT NULL,
  y1              INT NOT NULL,
  bot_color       SMALLINT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at         TIMESTAMPTZ NOT NULL,
  resolved_at     TIMESTAMPTZ,
  -- 'aborted' is not a real outcome — it means the server restarted mid-event
  -- and the zone was reverted defensively on boot without a real judgment.
  result          TEXT CHECK (result IN ('defended', 'corrupted', 'aborted')),
  corruption_pct  REAL,
  defenders       INT NOT NULL DEFAULT 0,
  CHECK (x1 >= x0 AND y1 >= y0)
);

-- events/engine.ts's boot recovery scans for exactly this.
CREATE INDEX corruption_events_unresolved_idx ON corruption_events (id) WHERE resolved_at IS NULL;

ALTER TABLE sessions ADD COLUMN event_bonus_until TIMESTAMPTZ;

COMMIT;
