-- Migration: 0019_workspace_erasures.sql
-- Audited workspace erasure log: one tombstone row per deleted workspace
-- recording what was removed, by whom and when. The log carries no business
-- content and references no workspace row (the workspace is gone), so the
-- fact of erasure stays auditable while member data is fully removed.
-- Additive only: no existing table changes shape and no trigger is altered.

CREATE TABLE IF NOT EXISTS workspace_erasures (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  erased_at TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  media_objects_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_workspace_erasures_ws
  ON workspace_erasures(workspace_id, erased_at);

CREATE INDEX IF NOT EXISTS idx_workspace_erasures_actor
  ON workspace_erasures(actor_user_id, erased_at);
