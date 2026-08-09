-- Templates are unlisted (link only, no directory), so the only people who
-- can find a bad one are the people it was shared with. This is their way to
-- say so.

BEGIN;

CREATE TABLE template_reports (
  template_id UUID   NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  session_id  BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One report per session. Without this a single person can manufacture
  -- whatever report count they like, and the number a moderator triages by
  -- becomes meaningless.
  PRIMARY KEY (template_id, session_id)
);

CREATE INDEX template_reports_template_idx ON template_reports (template_id);

COMMIT;
