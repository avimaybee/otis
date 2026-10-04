-- Migration: 0012_voice_media.sql
-- Gate 010: private voice media, durable transcription receipts and shared
-- workspace STT settings. Additive only; no second message/chat schema.

-- 0. provider_credentials previously allowed only conversation providers.
-- Groq is an STT-only credential; SQLite cannot alter a CHECK in place, so
-- rebuild the table preserving existing rows and the same primary key.
CREATE TABLE IF NOT EXISTS provider_credentials_v2 (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('gemini', 'opencode_go', 'groq')),
  encrypted_key TEXT NOT NULL,
  key_nonce TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('unverified', 'available', 'invalid_credential', 'unavailable', 'retired')) DEFAULT 'unverified',
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);
INSERT OR IGNORE INTO provider_credentials_v2
  (workspace_id, provider, encrypted_key, key_nonce, key_version, status, last_verified_at, created_at, updated_at)
  SELECT workspace_id, provider, encrypted_key, key_nonce, key_version, status, last_verified_at, created_at, updated_at
  FROM provider_credentials;
DROP TABLE provider_credentials;
ALTER TABLE provider_credentials_v2 RENAME TO provider_credentials;

-- 1. Shared workspace voice/STT configuration. Absent row means disabled.
CREATE TABLE IF NOT EXISTS workspace_voice_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stt_enabled INTEGER NOT NULL DEFAULT 0 CHECK(stt_enabled IN (0, 1)),
  stt_provider TEXT CHECK(stt_provider IS NULL OR stt_provider = 'groq'),
  stt_model TEXT CHECK(stt_model IS NULL OR stt_model IN ('whisper-large-v3-turbo', 'whisper-large-v3')),
  -- JSON array of actually tested capture containers; evidence, never inferred.
  verified_formats_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Private media objects. Bytes live in R2 under a server-built key; rows
-- carry only identity, validation and retention metadata. Quarantine rows are
-- never readable through the normal media route.
CREATE TABLE IF NOT EXISTS media_objects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  uploader_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Stable message UUID this recording is bound to; retries reuse this row
  -- and its single R2 object instead of orphaning another upload.
  client_message_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('quarantine', 'validated', 'transcribing', 'ready', 'rejected', 'expired', 'deleted')) DEFAULT 'quarantine',
  object_key TEXT NOT NULL,
  content_type TEXT,
  format TEXT CHECK(format IS NULL OR format IN ('audio/webm', 'audio/mp4', 'audio/ogg')),
  byte_size INTEGER,
  duration_ms INTEGER,
  -- Hash of the one-time scoped upload ticket; the raw ticket is never stored.
  upload_token_hash TEXT,
  upload_token_expires_at TEXT,
  upload_completed_at TEXT,
  validated_at TEXT,
  -- Raw audio retention boundary (created + 14 days).
  expires_at TEXT NOT NULL,
  rejection_code TEXT,
  rejection_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_objects_ws_state ON media_objects(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_media_objects_expiry ON media_objects(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_media_objects_token ON media_objects(upload_token_hash);
-- One media lifecycle per stable client message UUID and uploader scope.
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_objects_client_identity
  ON media_objects(workspace_id, chat_id, uploader_user_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

-- 3. One logical transcription receipt per media object. Route/provider/model
-- are snapshotted at acceptance; configuration changes affect future notes.
-- Conditional claims plus the media_id uniqueness permit at most one canonical
-- transcript even when a lost provider response requires another attempt.
CREATE TABLE IF NOT EXISTS media_transcriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  message_in_id TEXT REFERENCES messages_in(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'ready', 'failed', 'cancelled')) DEFAULT 'pending',
  route TEXT NOT NULL CHECK(route IN ('native', 'groq_stt')),
  provider TEXT,
  model TEXT,
  format TEXT NOT NULL CHECK(format IN ('audio/webm', 'audio/mp4', 'audio/ogg')),
  language_hint TEXT,
  transcript_text TEXT,
  transcript_language TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claim_owner TEXT,
  claim_expires_at TEXT,
  next_attempt_at TEXT,
  committed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (media_id)
);

CREATE INDEX IF NOT EXISTS idx_media_transcriptions_due ON media_transcriptions(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_media_transcriptions_ws ON media_transcriptions(workspace_id, state);
