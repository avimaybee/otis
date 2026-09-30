-- Migration: 0002_conversations_sources.sql
-- Gate II (004A): Durable conversations, sources, runs, steps, activity, clarifications, outbox, and Telegram link.

-- 1. Monotonic workspace acceptance sequence
ALTER TABLE workspaces ADD COLUMN last_acceptance_sequence INTEGER NOT NULL DEFAULT 0;

-- 2. Chats: one author per chat, full read visibility for members, monotonic activity cursor
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  model_override TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0, 1)),
  activity_cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

-- 3. Messages In: transport deduplication by (channel, external_id)
CREATE TABLE IF NOT EXISTS messages_in (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('web', 'telegram', 'system')),
  external_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  raw_payload TEXT,
  status TEXT NOT NULL CHECK(status IN ('unrouted', 'queued', 'processing', 'waiting_for_input', 'processed', 'unsupported', 'failed', 'cancelled')) DEFAULT 'queued',
  acceptance_sequence INTEGER,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel, external_id)
);

-- 4. System Jobs: durable job source for system-originated runs/events
CREATE TABLE IF NOT EXISTS system_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_kind TEXT NOT NULL CHECK(job_kind IN ('scheduled_daily_brief', 'reminder', 'summary_refresh', 'outbox_sweep', 'media_orphan_cleanup', 'export')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')) DEFAULT 'pending',
  scheduled_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 5. Agent Runs: bounded execution lifecycle linked to source message or system job
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages_in(id) ON DELETE SET NULL,
  source_job_id TEXT REFERENCES system_jobs(id) ON DELETE SET NULL,
  executor_kind TEXT NOT NULL CHECK(executor_kind IN ('agent', 'command', 'system')) DEFAULT 'agent',
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting_for_input', 'succeeded', 'partial', 'failed', 'cancelled')) DEFAULT 'queued',
  model_key TEXT,
  attempt_id TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((source_message_id IS NOT NULL AND source_job_id IS NULL) OR (source_message_id IS NULL AND source_job_id IS NOT NULL))
);

-- 6. Chat Messages: ordered messages in a chat turn
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_kind TEXT NOT NULL CHECK(author_kind IN ('member', 'system')),
  channel TEXT NOT NULL CHECK(channel IN ('web', 'telegram', 'system')),
  inbound_message_id TEXT REFERENCES messages_in(id) ON DELETE SET NULL,
  client_message_id TEXT,
  content_text TEXT NOT NULL,
  media_id TEXT,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chat_id, sequence)
);

-- 7. Run Steps: logical planned and executed steps with hash idempotency
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned', 'running', 'succeeded', 'failed', 'skipped')) DEFAULT 'planned',
  result_json TEXT,
  action_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, step_index)
);

-- 8. Run Activity: public activity envelope persisted before publishing
CREATE TABLE IF NOT EXISTS run_activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN (
    'message_accepted', 'queued', 'run_started', 'text_chunk',
    'step_started', 'step_finished', 'action_applied', 'reasoning_summary',
    'clarification_required', 'partial_failure', 'answer_saved',
    'run_finished', 'action_reverted'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (chat_id, cursor)
);

-- 9. Pending Clarifications: human question releasing execution slot
CREATE TABLE IF NOT EXISTS pending_clarifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL REFERENCES messages_in(id) ON DELETE CASCADE,
  requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  intended_operation TEXT NOT NULL,
  missing_fields TEXT NOT NULL,
  candidates_json TEXT,
  source_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'resolved', 'cancelled', 'superseded')) DEFAULT 'pending',
  resolution_response TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 10. Outbox: durable asynchronous dispatch to DO, Telegram, or background workers
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK(destination IN ('workspace_actor', 'telegram', 'summary_worker')),
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'delivered', 'failed_known', 'outcome_unknown', 'cancelled')) DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 11. Telegram Users: linking verified Telegram identities to Otis users & active workspace
CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selected_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  active_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 12. Transaction Guards for Atomic D1 Batches
CREATE TABLE IF NOT EXISTS acceptance_guards (
  id TEXT PRIMARY KEY,
  guard_ok INTEGER NOT NULL CHECK (guard_ok = 1)
);

CREATE TABLE IF NOT EXISTS link_redemptions (
  link_code_id TEXT PRIMARY KEY REFERENCES link_codes(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  redeemed_at TEXT NOT NULL,
  guard_ok INTEGER NOT NULL CHECK (guard_ok = 1)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_chats_workspace_id ON chats(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chats_author ON chats(workspace_id, author_user_id);
CREATE INDEX IF NOT EXISTS idx_chats_pagination ON chats(workspace_id, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_seq ON chat_messages(chat_id, sequence);
CREATE INDEX IF NOT EXISTS idx_chat_messages_client_msg ON chat_messages(workspace_id, client_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_in_ws_seq ON messages_in(workspace_id, acceptance_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_runs_ws_status ON agent_runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_run_activity_chat_cursor ON run_activity(chat_id, cursor);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(destination, status);
CREATE INDEX IF NOT EXISTS idx_pending_clarifications_ws ON pending_clarifications(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_telegram_users_user_id ON telegram_users(user_id);
