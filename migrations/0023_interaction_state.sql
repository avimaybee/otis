-- Migration: 0023_interaction_state.sql
-- C1 single-interaction revision and removal
-- Add the interaction_state projection with one row per stable interaction
-- root holding the current head removal state and revision plus indexed
-- occurrence metadata for timeline reads. Content stays in events.
-- Backfill one active row per legacy note visit contact and quote event
-- where each legacy root is its own event ID. Events already reverted
-- before migration get no row, matching the rebuild rule that excludes
-- reverted events before reduction. Events whose owning entity is gone
-- get no row either: replay drops their lifecycle on the entity_deleted
-- event, so backfilling them would resurrect removed clients.
-- Entity-less workspace notes are kept. The head value snapshot carries
-- the quote payload for quote rows so head-aware quote reduction can
-- recompute without rereading history. No legacy interaction event
-- carries a supersedes link (new logging never set one), so each
-- qualifying event stands as its own single-revision root and projection
-- equals replay. Chain links (revisions carrying a supersedes link or a
-- root marker) are excluded: their root row already exists on any database
-- where the chain was built, and the migration runs once on pre-C1 history
-- where chains cannot exist, so re-running the backfill can never fork a
-- revision into a bogus second root.
-- This migration touches only the new table so harnesses on any earlier
-- chain can adopt it with a single file. The interaction_removed event
-- kind allowlist lands separately with the events rebuild.

CREATE TABLE IF NOT EXISTS interaction_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  root_event_id TEXT NOT NULL,
  entity_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('note', 'visit', 'contact', 'quote')),
  head_event_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('active', 'removed')) DEFAULT 'active',
  occurred_at TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  head_value_json TEXT,
  PRIMARY KEY (workspace_id, root_event_id)
);
INSERT OR IGNORE INTO interaction_state
  (workspace_id, root_event_id, entity_id, kind, head_event_id, revision, state, occurred_at, sequence, updated_at, head_value_json)
  SELECT workspace_id, id, entity_id, kind, id, 1, 'active', occurred_at, sequence, created_at,
    CASE WHEN kind = 'quote' THEN payload_json ELSE NULL END
  FROM events AS e
  WHERE kind IN ('note', 'visit', 'contact', 'quote')
    AND supersedes_event_id IS NULL
    AND json_extract(payload_json, '$.interaction_id') IS NULL
    AND id NOT IN (SELECT reverts_event_id FROM events WHERE reverts_event_id IS NOT NULL)
    AND id NOT IN (
      SELECT json_extract(payload_json, '$.target_event_id') FROM events
      WHERE kind = 'revert'
        AND json_extract(payload_json, '$.target_event_id') IS NOT NULL
    )
    AND (entity_id IS NULL OR EXISTS (
      SELECT 1 FROM entities AS ent
      WHERE ent.workspace_id = e.workspace_id AND ent.id = e.entity_id
    ));
CREATE INDEX IF NOT EXISTS idx_interaction_state_ws_entity ON interaction_state(workspace_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_interaction_state_ws_entity_occurred ON interaction_state(workspace_id, entity_id, occurred_at);
