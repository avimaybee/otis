-- Migration: 0034_erasure_attempt_keys.sql
-- In-flight render attempt keys retained across erasure.
-- Erasure deletes every inventory row, so a render attempt that uploads
-- after the cascade cannot rely on its pre-registered media row. The
-- erasure intent records such attempt keys with a not-before deadline
-- (past any in-flight upload/settle window); cron leaves them alone until
-- the deadline, then sweeps them like any other leftover. Additive only:
-- one nullable column, no existing shape change.
ALTER TABLE workspace_erasure_cleanups ADD COLUMN attempt_keys_json TEXT;
