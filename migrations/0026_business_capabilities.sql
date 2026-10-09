-- Migration: 0026_business_capabilities.sql (unapplied at the production baseline)
-- C3/C4/C6: sourced contact, merge, attachment and reminder rule events.
-- so one note visit contact or quote can leave current use while history
-- stays append-only. SQLite cannot alter a CHECK in place, so rebuild the
-- events table preserving every row and column order following the
-- established 0021 pattern.
-- The interaction_state table created earlier carries no foreign key into
-- events, so its rows survive the rebuild untouched and stay valid because
-- event IDs and content are preserved.
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
DROP TABLE IF EXISTS events_backup_0026;
DROP TABLE IF EXISTS tasks_backup_0026;DROP TABLE IF EXISTS drafts_backup_0026;
DROP TABLE IF EXISTS suppressions_backup_0026;
DROP TABLE IF EXISTS entity_state_backup_0026;
DROP TABLE IF EXISTS memory_entries_backup_0026;
DROP TABLE IF EXISTS brief_items_backup_0026;
CREATE TABLE events_backup_0026 AS SELECT * FROM events;
UPDATE events SET supersedes_event_id = NULL, reverts_event_id = NULL;
CREATE TABLE tasks_backup_0026 AS SELECT * FROM tasks;
CREATE TABLE drafts_backup_0026 AS SELECT * FROM draft_projections;
CREATE TABLE suppressions_backup_0026 AS SELECT * FROM memory_suppressions;
CREATE TABLE entity_state_backup_0026 AS SELECT * FROM entity_state;
CREATE TABLE memory_entries_backup_0026 AS SELECT * FROM memory_entries;
CREATE TABLE brief_items_backup_0026 AS SELECT * FROM brief_items;
CREATE TABLE events_new_0026 (
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
    'interaction_removed',
    'contact_changed',
    'entity_merged',
    'attachment_linked',
    'attachment_unlinked',
    'reminder_rule_changed',
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
  supersedes_event_id TEXT REFERENCES events_new_0026(id) ON DELETE RESTRICT,
  reverts_event_id TEXT REFERENCES events_new_0026(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK(provenance IN ('stated', 'inferred')) DEFAULT 'stated',
  created_at TEXT NOT NULL,
  CHECK ((source_message_id IS NOT NULL AND source_job_id IS NULL) OR (source_message_id IS NULL AND source_job_id IS NOT NULL)),
  UNIQUE (workspace_id, sequence)
);
INSERT INTO events_new_0026
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
ALTER TABLE events_new_0026 RENAME TO events;
DELETE FROM tasks;
INSERT INTO tasks SELECT * FROM tasks_backup_0026;
DELETE FROM draft_projections;
INSERT INTO draft_projections SELECT * FROM drafts_backup_0026;
DELETE FROM memory_suppressions;
INSERT INTO memory_suppressions SELECT * FROM suppressions_backup_0026;
DELETE FROM entity_state;
INSERT INTO entity_state SELECT * FROM entity_state_backup_0026;
DELETE FROM memory_entries;
INSERT INTO memory_entries SELECT * FROM memory_entries_backup_0026;
DELETE FROM brief_items;
INSERT INTO brief_items SELECT * FROM brief_items_backup_0026;
UPDATE events
  SET supersedes_event_id = backup.supersedes_event_id, reverts_event_id = backup.reverts_event_id
  FROM events_backup_0026 AS backup WHERE events.id = backup.id;
DROP TABLE events_backup_0026;
DROP TABLE tasks_backup_0026;
DROP TABLE drafts_backup_0026;
DROP TABLE suppressions_backup_0026;
DROP TABLE entity_state_backup_0026;
DROP TABLE memory_entries_backup_0026;
DROP TABLE brief_items_backup_0026;
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

CREATE TABLE entity_contacts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('phone', 'email')),
  value TEXT NOT NULL, comparison_key TEXT NOT NULL, label TEXT,
  is_primary INTEGER NOT NULL CHECK(is_primary IN (0, 1)),
  state TEXT NOT NULL CHECK(state IN ('active', 'removed', 'disputed')),
  revision INTEGER NOT NULL, source_event_id TEXT NOT NULL, original_event_id TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_entity ON entity_contacts(workspace_id, entity_id, state, method);
CREATE UNIQUE INDEX idx_contacts_primary ON entity_contacts(workspace_id, entity_id, method) WHERE is_primary = 1 AND state = 'active';
INSERT INTO entity_contacts
  SELECT 'legacy_phone_' || entity_id, workspace_id, entity_id, 'phone', COALESCE(value_text, ''),
    replace(replace(replace(replace(replace(replace(replace(replace(COALESCE(value_text, ''), ' ', ''), char(9), ''), char(10), ''), char(13), ''), '(', ''), ')', ''), '.', ''), '-', ''),
    NULL, 1, CASE WHEN state = 'disputed' THEN 'disputed' WHEN COALESCE(value_text, '') = '' THEN 'removed' ELSE 'active' END,
    revision, source_event_id,
    COALESCE((SELECT e.id FROM events e WHERE e.workspace_id = entity_state.workspace_id AND e.entity_id = entity_state.entity_id
      AND e.kind = 'field_change' AND json_extract(e.payload_json, '$.field_name') = 'phone'
      AND NOT EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert' AND (r.reverts_event_id = e.id OR json_extract(r.payload_json, '$.target_event_id') = e.id)) ORDER BY e.sequence LIMIT 1), source_event_id), updated_at
  FROM entity_state WHERE field_name = 'phone' AND source_event_id IS NOT NULL;
CREATE TABLE entity_redirects (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
  decisions_json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_entity_id), CHECK(source_entity_id != target_entity_id)
);
CREATE INDEX idx_redirect_target ON entity_redirects(workspace_id, target_entity_id);
CREATE TABLE attachment_links (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL, interaction_id TEXT, media_id TEXT NOT NULL, label TEXT,
  state TEXT NOT NULL CHECK(state IN ('active', 'unlinked')), revision INTEGER NOT NULL,
  source_event_id TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_attachment_entity ON attachment_links(workspace_id, entity_id, state, id);
CREATE INDEX idx_attachment_media ON attachment_links(workspace_id, media_id, state);
CREATE TABLE reminder_rules (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, entity_id TEXT, text TEXT NOT NULL, timezone TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('web', 'telegram')), spec_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'cancelled')),
  revision INTEGER NOT NULL, source_event_id TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_rule_owner ON reminder_rules(workspace_id, user_id, status);
CREATE INDEX idx_rule_entity ON reminder_rules(workspace_id, entity_id, status);
ALTER TABLE media_objects ADD COLUMN filename TEXT;
ALTER TABLE media_objects ADD COLUMN retained INTEGER NOT NULL DEFAULT 0 CHECK(retained IN (0, 1));
ALTER TABLE media_objects ADD COLUMN deletion_claimed_at TEXT;
