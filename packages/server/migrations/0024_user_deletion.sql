-- Self-service account deletion (the "your rights" half of the Privacy
-- Policy — see packages/web/public/privacy.html).
--
-- Hard-deleting the row is not an option and never will be: chat_messages,
-- chat_reports, chat_mutes and audit_log all hold NOT NULL references to
-- users(id), and those are exactly the rows a deletion must NOT destroy
-- (open reports against the account, and the staff audit trail that proves
-- who actioned what). So "delete" is erasure-by-anonymisation: every piece
-- of personal data is scrubbed off the row and every credential row is
-- really deleted, while the id survives to keep those trails referentially
-- intact.
--
-- disabled_at (0011_users_disabled.sql) already blocks login and cuts live
-- sessions, and the deletion sets it too, so nothing needs to learn a new
-- check. This column adds only the one thing disabled_at cannot express: the
-- difference between "a mod disabled you" and "you asked to be erased" —
-- which is what a support request, a re-enable decision, or an audit of the
-- privacy promise has to be able to tell apart after the fact.

BEGIN;

ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;

-- Partial: deleted accounts are a rounding error next to live ones, and the
-- only queries that filter on this want just those rows.
CREATE INDEX users_deleted_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;

COMMIT;
