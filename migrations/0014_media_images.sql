-- Migration: 0014_media_images.sql
-- Image attachments: widen the media_objects format CHECK to the verified
-- image containers. SQLite cannot alter a CHECK in place, so rebuild the
-- table preserving existing rows, keys and identity scope. Voice flows,
-- transcription receipts and retention semantics are untouched.
--
-- D1 enforces foreign keys and forbids toggling PRAGMA foreign_keys inside
-- a migration, so this uses the documented D1 rebuild pattern: defer FK
-- enforcement for the transaction. Deferral does not suppress ON DELETE
-- CASCADE, and dropping media_objects would cascade-delete every
-- media_transcriptions receipt, so receipts are backed up first and restored
-- after the rename; row ids are stable, so each receipt stays attached to
-- the same media. A regular (non-TEMP) backup table is used so the copy
-- survives executors that run each statement on its own connection.

PRAGMA defer_foreign_keys=on;
DROP TABLE IF EXISTS media_transcriptions_backup_0014;
CREATE TABLE media_transcriptions_backup_0014 AS SELECT * FROM media_transcriptions;
CREATE TABLE IF NOT EXISTS media_objects_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  uploader_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_message_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('quarantine', 'validated', 'transcribing', 'ready', 'rejected', 'expired', 'deleted')) DEFAULT 'quarantine',
  object_key TEXT NOT NULL,
  content_type TEXT,
  format TEXT CHECK(format IS NULL OR format IN ('audio/webm', 'audio/mp4', 'audio/ogg', 'image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER,
  duration_ms INTEGER,
  upload_token_hash TEXT,
  upload_token_expires_at TEXT,
  upload_completed_at TEXT,
  validated_at TEXT,
  expires_at TEXT NOT NULL,
  rejection_code TEXT,
  rejection_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO media_objects_v2
  (id, workspace_id, chat_id, uploader_user_id, client_message_id, state, object_key, content_type, format,
   byte_size, duration_ms, upload_token_hash, upload_token_expires_at, upload_completed_at, validated_at,
   expires_at, rejection_code, rejection_message, created_at, updated_at)
  SELECT id, workspace_id, chat_id, uploader_user_id, client_message_id, state, object_key, content_type, format,
   byte_size, duration_ms, upload_token_hash, upload_token_expires_at, upload_completed_at, validated_at,
   expires_at, rejection_code, rejection_message, created_at, updated_at
  FROM media_objects;
DROP TABLE media_objects;
ALTER TABLE media_objects_v2 RENAME TO media_objects;
INSERT INTO media_transcriptions SELECT * FROM media_transcriptions_backup_0014;
DROP TABLE media_transcriptions_backup_0014;

CREATE INDEX IF NOT EXISTS idx_media_objects_ws_state ON media_objects(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_media_objects_expiry ON media_objects(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_media_objects_token ON media_objects(upload_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_objects_client_identity
  ON media_objects(workspace_id, chat_id, uploader_user_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
PRAGMA defer_foreign_keys=off;
