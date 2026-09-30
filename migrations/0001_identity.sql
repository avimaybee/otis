-- Migration: 0001_identity.sql
-- Gate I (003A): Identity, workspaces, memberships, sessions, invites, and settings foundations.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  business_revision INTEGER NOT NULL DEFAULT 0,
  membership_revision INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_attempt_id TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_users (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS membership_audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK(action IN ('created', 'invited', 'joined', 'removed', 'transferred_owner', 'left')),
  occurred_at TEXT NOT NULL,
  details TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_user_id TEXT REFERENCES users(id)
);

-- Enforces atomic, exactly-once redemption with strict guard conditions in D1 batches
CREATE TABLE IF NOT EXISTS invite_redemptions (
  invite_id TEXT PRIMARY KEY REFERENCES invites(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TEXT NOT NULL,
  guard_ok INTEGER NOT NULL CHECK (guard_ok = 1)
);

CREATE TABLE IF NOT EXISTS link_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('gemini', 'opencode_go')),
  encrypted_key TEXT NOT NULL,
  key_nonce TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('unverified', 'available', 'invalid_credential', 'unavailable', 'retired')) DEFAULT 'unverified',
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  default_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brief_enabled INTEGER NOT NULL DEFAULT 0 CHECK(brief_enabled IN (0, 1)),
  brief_local_time TEXT,
  brief_timezone TEXT,
  brief_weekdays TEXT,
  brief_channel TEXT NOT NULL DEFAULT 'web' CHECK(brief_channel IN ('web', 'telegram')),
  preferred_language TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- Indexes for efficient queries and scoping
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_workspace_email ON invites(workspace_id, invited_email);
CREATE INDEX IF NOT EXISTS idx_workspace_users_user_id ON workspace_users(user_id);
CREATE INDEX IF NOT EXISTS idx_link_codes_code_hash ON link_codes(code_hash);
