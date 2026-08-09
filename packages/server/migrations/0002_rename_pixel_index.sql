-- Vocabulary change: the canvas unit is a "pixel", not a "cell".
--
-- 0001 now creates this index as pixel_events_xy_idx. Databases migrated
-- before that change still carry the old name, so rename it here. Fresh
-- installs create the new name in 0001 and this is a no-op.

ALTER INDEX IF EXISTS pixel_events_cell_idx RENAME TO pixel_events_xy_idx;
