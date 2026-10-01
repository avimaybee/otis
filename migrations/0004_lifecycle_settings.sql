-- Migration: 0004_lifecycle_settings.sql
-- Gate 003B: lifecycle transaction guards and attributed settings/credential audit.
-- Identity tables (users, workspaces, memberships, provider_credentials,
-- workspace_settings, member_settings) already exist from 0001.

-- Enforces atomic lifecycle preconditions in D1 batches
CREATE TABLE IF NOT EXISTS lifecycle_guards (
  id TEXT PRIMARY KEY,
  guard_ok INTEGER NOT NULL CHECK (guard_ok = 1)
);

-- Attributed audit for shared/member/credential configuration changes.
-- Separate from business ledger projections and membership_audit.
CREATE TABLE IF NOT EXISTS settings_audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK(scope IN ('shared', 'member', 'credential')),
  changed_fields_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_ws ON settings_audit(workspace_id, occurred_at);
