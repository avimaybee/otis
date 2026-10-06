-- Migration: 0015_message_image_attachments.sql
-- Image attachments on chat messages: a message may carry up to
-- IMAGE_BOUNDS.MAX_PER_MESSAGE validated still images. The link rows are the
-- durable receipt attaching consumed media to the turn; bytes stay in R2 and
-- no transcription intent is created (images are prompt input, never STT).
-- Additive only; voice media_id flows and retention semantics are untouched.

CREATE TABLE IF NOT EXISTS message_image_attachments (
  chat_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_message_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_message_image_attachments_message
  ON message_image_attachments(chat_message_id, position);
