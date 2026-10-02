-- Migration: 0008_memory_and_agent_runs.sql
-- Gate 006A: Canonical memory tables, suppressions, extractive summaries, refresh jobs,
-- active note FTS, agent run progress/model snapshot columns, and daily actions quota tracking.

-- 1. Memory Entries: curated durable notes (workspace, entity, member preferences)
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('workspace', 'entity', 'member_in_workspace')),
  subject_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('communication_preference', 'relationship_context', 'workflow_context', 'other_context')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'forgotten')) DEFAULT 'active',
  provenance TEXT NOT NULL CHECK(provenance IN ('stated', 'inferred')) DEFAULT 'stated',
  source_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages_in(id) ON DELETE SET NULL,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseding_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  business_revision INTEGER NOT NULL,
  CHECK ((scope = 'workspace' AND subject_id IS NULL) OR (scope IN ('entity', 'member_in_workspace') AND subject_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_active
  ON memory_entries(workspace_id, status, scope, subject_id);

CREATE INDEX IF NOT EXISTS idx_memory_entries_revision
  ON memory_entries(workspace_id, business_revision);

-- 2. Memory Suppressions: explicit forget tombstone tracking preventing resurrection
CREATE TABLE IF NOT EXISTS memory_suppressions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL,
  source_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages_in(id) ON DELETE SET NULL,
  suppression_event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_suppressions_target
  ON memory_suppressions(workspace_id, target_memory_id);

-- 3. Memory Summaries: deterministic extractive summaries with source manifests
CREATE TABLE IF NOT EXISTS memory_summaries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('workspace', 'entity', 'member_in_workspace')),
  subject_key TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  built_from_revision INTEGER NOT NULL,
  format_version INTEGER NOT NULL DEFAULT 1,
  generation_model TEXT,
  built_at TEXT NOT NULL,
  UNIQUE(workspace_id, scope, subject_key)
);

-- 4. Memory Refresh Jobs: durable claimable background jobs for summary maintenance
CREATE TABLE IF NOT EXISTS memory_refresh_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('workspace', 'entity', 'member_in_workspace')),
  subject_key TEXT NOT NULL,
  target_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'completed', 'failed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT NOT NULL,
  claim_token TEXT,
  claim_expires_at TEXT,
  error_class TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, scope, subject_key, target_revision)
);

CREATE INDEX IF NOT EXISTS idx_memory_refresh_jobs_pending
  ON memory_refresh_jobs(workspace_id, state, next_attempt_at);

-- 5. Memory Entries FTS: full-text search index on active note text
CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
  entry_id UNINDEXED,
  content
);

-- 6. Agent Runs extension: immutable model snapshot and durable progress checkpoint
ALTER TABLE agent_runs ADD COLUMN model_snapshot_json TEXT;
ALTER TABLE agent_runs ADD COLUMN agent_progress_json TEXT;

-- 7. Workspace Daily Actions: atomic counter for daily mutation limit enforcement
CREATE TABLE IF NOT EXISTS workspace_daily_actions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date_utc TEXT NOT NULL,
  action_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, date_utc)
);
