-- Migration: 0033_erasure_r2_cleanup.sql
-- Retry inventory for post-commit workspace-erasure R2 cleanup.
-- Erasure commits its D1 cascade first and deletes R2 bytes after, so a
-- failed byte deletion can never leave live rows pointing at missing bytes.
-- Whatever the request-bounded cleanup cannot finish is recorded here (one
-- row per erased workspace: failed keys plus un-swept prefixes) and the
-- existing cron sweep retries it to completion, deleting the row when done.
-- Additive only: one new table, no existing shape change.
CREATE TABLE IF NOT EXISTS workspace_erasure_cleanups (
  workspace_id TEXT PRIMARY KEY,
  erasure_id TEXT NOT NULL,
  failed_keys_json TEXT NOT NULL,
  pending_prefixes_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
