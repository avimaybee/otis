-- Migration: 0021_entity_deleted_kind.sql
-- Conversational entity deletion: allow the entity_deleted event kind so a
-- lead and all of its projected details can be removed through the ledger
-- while history stays append-only. SQLite cannot alter a CHECK in place, so
-- rebuild the events table preserving every row and column order.
--
-- Dropping the table performs an implicit row delete that fires CASCADE and
-- SET NULL actions on referencing rows, and self-references would fail the
-- drop outright, so this migration backs up the events rows plus every
-- dependent table first, nulls self-references, rebuilds, then restores all
-- content including the self-reference links. The append-only guards are
-- dropped first (they would block the null-out) and recreated verbatim at
-- the end. Event history content is untouched.

DROP TRIGGER IF EXISTS trg_events_prevent_delete;
DROP TRIGGER IF EXISTS trg_events_prevent_update;
DROP TABLE IF EXISTS events_backup_0021;
DROP TABLE IF EXISTS tasks_backup_0021;DROP TABLE IF EXISTS drafts_backup_0021;
DROP TABLE IF EXISTS suppressions_backup_0021;
DROP TABLE IF EXISTS entity_state_backup_0021;
DROP TABLE IF EXISTS memory_entries_backup_0021;
DROP TABLE IF EXISTS brief_items_backup_0021;
CREATE TABLE events_backup_0021 AS SELECT * FROM events;
UPDATE events SET supersedes_event_id = NULL, reverts_event_id = NULL;
CREATE TABLE tasks_backup_0021 AS SELECT * FROM tasks;
CREATE TABLE drafts_backup_0021 AS SELECT * FROM draft_projections;
CREATE TABLE suppressions_backup_0021 AS SELECT * FROM memory_suppressions;
CREATE TABLE entity_state_backup_0021 AS SELECT * FROM entity_state;
CREATE TABLE memory_entries_backup_0021 AS SELECT * FROM memory_entries;
CREATE TABLE brief_items_backup_0021 AS SELECT * FROM brief_items;
CREATE TABLE events_new_0021 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  entity_id TEXT,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('member', 'system')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_job_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN (
    'entity_created',
    'entity_renamed',
    'alias_added',
    'note',
    'visit',
    'contact',
    'quote',
    'status_change',
    'field_change',
    'task_created',
    'task_updated',
    'task_done',
    'task_cancelled',
    'draft_created',
    'draft_updated',
    'message_sent_by_member',
    'conflict_resolved',
    'memory_note',
    'memory_forgotten',
    'entity_deleted',
    'revert'
  )),
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('web', 'telegram', 'system')),
  source_message_id TEXT REFERENCES messages_in(id) ON DELETE RESTRICT,
  source_job_id TEXT REFERENCES system_jobs(id) ON DELETE RESTRICT,
  action_id TEXT NOT NULL,
  supersedes_event_id TEXT REFERENCES events_new_0021(id) ON DELETE RESTRICT,
  reverts_event_id TEXT REFERENCES events_new_0021(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK(provenance IN ('stated', 'inferred')) DEFAULT 'stated',
  created_at TEXT NOT NULL,
  CHECK ((source_message_id IS NOT NULL AND source_job_id IS NULL) OR (source_message_id IS NULL AND source_job_id IS NOT NULL)),
  UNIQUE (workspace_id, sequence)
);
INSERT INTO events_new_0021
  (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, actor_job_id,
   kind, schema_version, payload_json, occurred_at, recorded_at, channel,
   source_message_id, source_job_id, action_id, supersedes_event_id, reverts_event_id,
   provenance, created_at)
  SELECT id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, actor_job_id,
   kind, schema_version, payload_json, occurred_at, recorded_at, channel,
   source_message_id, source_job_id, action_id, supersedes_event_id, reverts_event_id,
   provenance, created_at
  FROM events;
DROP TABLE events;
ALTER TABLE events_new_0021 RENAME TO events;
DELETE FROM tasks;
INSERT INTO tasks SELECT * FROM tasks_backup_0021;
DELETE FROM draft_projections;
INSERT INTO draft_projections SELECT * FROM drafts_backup_0021;
DELETE FROM memory_suppressions;
INSERT INTO memory_suppressions SELECT * FROM suppressions_backup_0021;
DELETE FROM entity_state;
INSERT INTO entity_state SELECT * FROM entity_state_backup_0021;
DELETE FROM memory_entries;
INSERT INTO memory_entries SELECT * FROM memory_entries_backup_0021;
DELETE FROM brief_items;
INSERT INTO brief_items SELECT * FROM brief_items_backup_0021;
UPDATE events
  SET supersedes_event_id = backup.supersedes_event_id, reverts_event_id = backup.reverts_event_id
  FROM events_backup_0021 AS backup WHERE events.id = backup.id;
DROP TABLE events_backup_0021;
DROP TABLE tasks_backup_0021;
DROP TABLE drafts_backup_0021;
DROP TABLE suppressions_backup_0021;
DROP TABLE entity_state_backup_0021;
DROP TABLE memory_entries_backup_0021;
DROP TABLE brief_items_backup_0021;
CREATE INDEX IF NOT EXISTS idx_events_ws_seq ON events(workspace_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_ws_entity ON events(workspace_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_ws_action ON events(workspace_id, action_id);
CREATE INDEX IF NOT EXISTS idx_events_supersedes ON events(supersedes_event_id);
CREATE INDEX IF NOT EXISTS idx_events_reverts ON events(reverts_event_id);
CREATE TRIGGER IF NOT EXISTS trg_events_prevent_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only; ordinary deletion is prohibited');
END;
CREATE TRIGGER IF NOT EXISTS trg_events_prevent_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable; updates are prohibited');
END;
