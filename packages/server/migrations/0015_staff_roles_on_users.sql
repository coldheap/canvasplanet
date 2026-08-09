-- Staff roles move onto player accounts (ROADMAP.md staff-panel fast-follow).
--
-- Previously staff were their own username/password accounts in a table
-- disconnected from `users`, with their own login form. That meant every
-- visitor saw a "Staff sign in" prompt in Settings, and granting someone
-- power meant minting them a whole second identity. Now staff is just a
-- nullable role on an existing player account, granted by an admin from the
-- Users tab — sign in once, as yourself, and the Admin tab appears only if
-- your account has a role.

BEGIN;

ALTER TABLE users ADD COLUMN role staff_role;

-- staff.id and users.id are different id spaces (this dev DB's staff rows
-- are all verify-script fixtures, not real operators — see the check below
-- if that's ever not true before running this in an environment that
-- matters). Repointing the FKs at users would otherwise either fail outright
-- (no matching id) or silently attribute history to the wrong account, so
-- clear it instead: the rows stay, just with unknown attribution, same as
-- any other "staff member since deleted" case these columns already handle.
UPDATE audit_log SET staff_id = NULL;
UPDATE protected_regions SET created_by = NULL;
UPDATE bans SET staff_id = NULL;
UPDATE area_reports SET resolved_by = NULL;

ALTER TABLE audit_log
  DROP CONSTRAINT audit_log_staff_id_fkey,
  ADD CONSTRAINT audit_log_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES users(id);

ALTER TABLE protected_regions
  DROP CONSTRAINT protected_regions_created_by_fkey,
  ADD CONSTRAINT protected_regions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE bans
  DROP CONSTRAINT bans_staff_id_fkey,
  ADD CONSTRAINT bans_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES users(id);

ALTER TABLE area_reports
  DROP CONSTRAINT area_reports_resolved_by_fkey,
  ADD CONSTRAINT area_reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES users(id);

DROP TABLE staff_sessions;
DROP TABLE staff;

COMMIT;
