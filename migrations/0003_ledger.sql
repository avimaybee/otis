-- Migration: 0003_ledger.sql
-- Gate III (002): Auditable business ledger, projections, dispute, and grouped undo.
-- In accordance with architecture.md sections 5, 8-10, docs/contracts.md, and plans/002-ledger.md.

-- 1. Workspace monotonic event sequence & Pending Clarifications durable payload
ALTER TABLE workspaces ADD COLUMN last_event_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_clarifications ADD COLUMN operation_payload_json TEXT;

-- 2. Entities: core business entities (leads, clients, partners)
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lead',
  status TEXT NOT NULL CHECK(status IN ('new', 'cold', 'warm', 'hot', 'won', 'lost', 'deprioritized')) DEFAULT 'new',
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 3. Entity Aliases: former names and alternative references
CREATE TABLE IF NOT EXISTS entity_aliases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, alias)
);

-- 4. Events: immutable append-only auditable event stream
CREATE TABLE IF NOT EXISTS events (
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
  supersedes_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
  reverts_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK(provenance IN ('stated', 'inferred')) DEFAULT 'stated',
  created_at TEXT NOT NULL,
  CHECK ((source_message_id IS NOT NULL AND source_job_id IS NULL) OR (source_message_id IS NULL AND source_job_id IS NOT NULL)),
  UNIQUE (workspace_id, sequence)
);

-- 5. Action Receipts: logical command deduplication and idempotency
CREATE TABLE IF NOT EXISTS action_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  command_name TEXT NOT NULL,
  result_status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('member', 'system')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages_in(id) ON DELETE SET NULL,
  source_job_id TEXT REFERENCES system_jobs(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  step_id TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
  committed_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, action_id)
);

-- 6. Entity State: deterministic rebuildable projection of current field values and disputes
CREATE TABLE IF NOT EXISTS entity_state (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('clear', 'disputed')) DEFAULT 'clear',
  value_text TEXT,
  value_json TEXT,
  provenance TEXT NOT NULL CHECK(provenance IN ('stated', 'inferred')) DEFAULT 'stated',
  source_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  candidate_event_ids_json TEXT,
  last_confirmed_value_text TEXT,
  last_confirmed_value_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, entity_id, field_name)
);

-- 7. Tasks: projected actionable commitments with typed due dates and snooze
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'done', 'cancelled')) DEFAULT 'open',
  due_kind TEXT CHECK(due_kind IN ('date', 'instant') OR due_kind IS NULL),
  due_local_date TEXT,
  due_instant TEXT,
  due_timezone TEXT,
  snooze_until TEXT,
  source_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 8. Draft Projections: projected outward communication drafts
CREATE TABLE IF NOT EXISTS draft_projections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK(channel IN ('whatsapp', 'email', 'sms', 'other')),
  recipient_address TEXT,
  content_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'member_confirmed_sent', 'archived')) DEFAULT 'draft',
  source_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 9. Field Defs: reserved custom field registry
CREATE TABLE IF NOT EXISTS field_defs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  display_label TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK(value_type IN ('string', 'number', 'boolean', 'enum', 'date', 'currency')),
  is_core INTEGER NOT NULL DEFAULT 1 CHECK(is_core IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, field_name)
);

-- 10. Ledger Guards for Atomic D1 Batches
CREATE TABLE IF NOT EXISTS ledger_guards (
  id TEXT PRIMARY KEY,
  guard_ok INTEGER NOT NULL CHECK (guard_ok = 1)
);

-- Indexes for query efficiency
CREATE INDEX IF NOT EXISTS idx_entities_ws ON entities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_ws_alias ON entity_aliases(workspace_id, alias);
CREATE INDEX IF NOT EXISTS idx_events_ws_seq ON events(workspace_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_ws_entity ON events(workspace_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_ws_action ON events(workspace_id, action_id);
CREATE INDEX IF NOT EXISTS idx_events_supersedes ON events(supersedes_event_id);
CREATE INDEX IF NOT EXISTS idx_events_reverts ON events(reverts_event_id);
CREATE INDEX IF NOT EXISTS idx_entity_state_ws_entity ON entity_state(workspace_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_entity ON tasks(workspace_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_action_receipts_ws_action ON action_receipts(workspace_id, action_id);

-- 11. Immutability Triggers for Append-Only Guarantees
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

CREATE TRIGGER IF NOT EXISTS trg_action_receipts_prevent_delete
BEFORE DELETE ON action_receipts
BEGIN
  SELECT RAISE(ABORT, 'action_receipts are append-only; ordinary deletion is prohibited');
END;
