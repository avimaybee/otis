-- Migration: 0005_actor_dispatch.sql
-- Gate 004B: oldest-first dispatch lookup for the workspace actor outbox.
-- No new tables: leases, runs, steps, activity, clarifications, and outbox
-- already exist from 0002. This only indexes the dispatch scan.

CREATE INDEX IF NOT EXISTS idx_outbox_dispatch
  ON outbox(workspace_id, destination, status, created_at, id);
