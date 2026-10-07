-- Migration: 0018_reminders.sql
-- One-off member reminders: confirmed delivery at an explicit instant over
-- the member's chosen channel, separate from the daily brief cadence.
-- Additive only: the brief flow never reads this table, and no existing
-- projection changes shape. Delivery claims a row pending-to-sent
-- conditionally, so concurrent sweeps deliver exactly once. Cancelled and
-- terminal rows are retained as audit, never resurrected.

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  action_id TEXT NOT NULL,
  text TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  timezone TEXT,
  channel TEXT NOT NULL DEFAULT 'web' CHECK(channel IN ('web', 'telegram')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'cancelled', 'failed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, action_id)
);

CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON reminders(status, remind_at);
