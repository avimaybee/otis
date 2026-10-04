-- Migration: 0013_briefs.sql
-- Gate 011B: canonical scheduled daily briefs with saved item positions.
-- Additive only; no changes to existing tables. Scheduler-owned rows per
-- docs/contracts.md table ownership; business writes still go through the
-- ledger. One canonical brief per (workspace, user, local date, kind).

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'scheduled_daily' CHECK(kind IN ('scheduled_daily')),
  status TEXT NOT NULL CHECK(status IN ('ready', 'empty')) DEFAULT 'ready',
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  body_text TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, user_id, local_date, kind)
);

CREATE TABLE IF NOT EXISTS brief_items (
  brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('promise_due', 'task_due', 'undated', 'stale_lead')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_event_id TEXT,
  due_label TEXT,
  PRIMARY KEY (brief_id, position)
);

CREATE INDEX IF NOT EXISTS idx_briefs_ws_user_date ON briefs(workspace_id, user_id, local_date);
