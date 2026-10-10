-- Migration: 0030_records_flexibility.sql
-- Forward schema extension for editable records: records_lists, records_list_columns,
-- records_rows, records_values, custom field options/calculations, and records events.
-- In accordance with plans/editable-records.md Section 5.

DROP TRIGGER IF EXISTS trg_events_prevent_delete;
DROP TRIGGER IF EXISTS trg_events_prevent_update;
DROP TABLE IF EXISTS events_backup_0030;
DROP TABLE IF EXISTS tasks_backup_0030;
DROP TABLE IF EXISTS drafts_backup_0030;
DROP TABLE IF EXISTS suppressions_backup_0030;
DROP TABLE IF EXISTS entity_state_backup_0030;
DROP TABLE IF EXISTS memory_entries_backup_0030;
DROP TABLE IF EXISTS brief_items_backup_0030;

CREATE TABLE events_backup_0030 AS SELECT * FROM events;
UPDATE events SET supersedes_event_id = NULL, reverts_event_id = NULL;

CREATE TABLE tasks_backup_0030 AS SELECT * FROM tasks;
CREATE TABLE drafts_backup_0030 AS SELECT * FROM draft_projections;
CREATE TABLE suppressions_backup_0030 AS SELECT * FROM memory_suppressions;
CREATE TABLE entity_state_backup_0030 AS SELECT * FROM entity_state;
CREATE TABLE memory_entries_backup_0030 AS SELECT * FROM memory_entries;
CREATE TABLE brief_items_backup_0030 AS SELECT * FROM brief_items;

CREATE TABLE events_new_0030 (
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
    'attachment_updated',
    'revert',
    'record_cell_changed',
    'record_row_created',
    'record_row_archived',
    'record_row_restored',
    'record_list_created',
    'record_list_updated',
    'record_list_archived',
    'record_list_restored',
    'record_column_created',
    'record_column_updated',
    'record_column_archived',
    'record_column_restored',
    'field_definition_created',
    'field_definition_updated',
    'calculation_defined'
  )),
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('web', 'telegram', 'system')),
  source_message_id TEXT REFERENCES messages_in(id) ON DELETE RESTRICT,
  source_job_id TEXT REFERENCES system_jobs(id) ON DELETE RESTRICT,
  action_id TEXT NOT NULL,
  supersedes_event_id TEXT REFERENCES events_new_0030(id) ON DELETE RESTRICT,
  reverts_event_id TEXT REFERENCES events_new_0030(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK(provenance IN ('stated', 'inferred')) DEFAULT 'stated',
  created_at TEXT NOT NULL,
  CHECK ((source_message_id IS NOT NULL AND source_job_id IS NULL) OR (source_message_id IS NULL AND source_job_id IS NOT NULL)),
  UNIQUE (workspace_id, sequence)
);

INSERT INTO events_new_0030
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
ALTER TABLE events_new_0030 RENAME TO events;

DELETE FROM tasks;
INSERT INTO tasks SELECT * FROM tasks_backup_0030;
DELETE FROM draft_projections;
INSERT INTO draft_projections SELECT * FROM drafts_backup_0030;
DELETE FROM memory_suppressions;
INSERT INTO memory_suppressions SELECT * FROM suppressions_backup_0030;
DELETE FROM entity_state;
INSERT INTO entity_state SELECT * FROM entity_state_backup_0030;
DELETE FROM memory_entries;
INSERT INTO memory_entries SELECT * FROM memory_entries_backup_0030;
DELETE FROM brief_items;
INSERT INTO brief_items SELECT * FROM brief_items_backup_0030;

UPDATE events
  SET supersedes_event_id = backup.supersedes_event_id, reverts_event_id = backup.reverts_event_id
  FROM events_backup_0030 AS backup WHERE events.id = backup.id;

DROP TABLE events_backup_0030;
DROP TABLE tasks_backup_0030;
DROP TABLE drafts_backup_0030;
DROP TABLE suppressions_backup_0030;
DROP TABLE entity_state_backup_0030;
DROP TABLE memory_entries_backup_0030;
DROP TABLE brief_items_backup_0030;

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

-- Extend field_defs with options and calculation definitions
ALTER TABLE field_defs ADD COLUMN options_json TEXT;
ALTER TABLE field_defs ADD COLUMN calculation_json TEXT;

-- 1. Records Lists
CREATE TABLE IF NOT EXISTS records_lists (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('entity', 'custom', 'task', 'interaction', 'draft')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_records_lists_ws_status ON records_lists(workspace_id, status);

-- 2. Records List Columns
CREATE TABLE IF NOT EXISTS records_list_columns (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  field_id TEXT,
  is_core INTEGER NOT NULL DEFAULT 0 CHECK(is_core IN (0, 1)),
  core_binding_json TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0, 1)),
  width INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, list_id) REFERENCES records_lists(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_records_list_columns_ws_list ON records_list_columns(workspace_id, list_id, position);

-- 3. Records Custom Rows
CREATE TABLE IF NOT EXISTS records_rows (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, list_id) REFERENCES records_lists(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_records_rows_ws_list ON records_rows(workspace_id, list_id, status);

-- 4. Records Values
CREATE TABLE IF NOT EXISTS records_values (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL,
  column_id TEXT NOT NULL,
  value_json TEXT,
  value_text TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  source_event_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, row_id, column_id),
  FOREIGN KEY (workspace_id, row_id) REFERENCES records_rows(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_records_values_ws_row ON records_values(workspace_id, row_id);

-- Seed built-in lists for existing workspaces
INSERT OR IGNORE INTO records_lists (workspace_id, id, name, source_kind, status, revision, created_at, updated_at)
SELECT id, 'leads', 'Leads', 'entity', 'active', 1, created_at, updated_at FROM workspaces;

INSERT OR IGNORE INTO records_lists (workspace_id, id, name, source_kind, status, revision, created_at, updated_at)
SELECT id, 'tasks', 'Tasks', 'task', 'active', 1, created_at, updated_at FROM workspaces;

INSERT OR IGNORE INTO records_lists (workspace_id, id, name, source_kind, status, revision, created_at, updated_at)
SELECT id, 'notes', 'Notes & interactions', 'interaction', 'active', 1, created_at, updated_at FROM workspaces;

INSERT OR IGNORE INTO records_lists (workspace_id, id, name, source_kind, status, revision, created_at, updated_at)
SELECT id, 'drafts', 'Drafts', 'draft', 'active', 1, created_at, updated_at FROM workspaces;
