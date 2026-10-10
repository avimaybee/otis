-- Migration: 0031_generated_documents.sql
-- Durable foundation for document attachments (PDF, text, Markdown)
-- and generated multi-page documents (revisions, render state, output media).

CREATE TABLE IF NOT EXISTS message_document_attachments (
  chat_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_message_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_msg_doc_attach_msg
  ON message_document_attachments(chat_message_id, position);

CREATE TABLE IF NOT EXISTS generated_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gen_docs_ws_chat
  ON generated_documents(workspace_id, source_chat_id, updated_at);

CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES generated_documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  parent_revision_id TEXT REFERENCES document_revisions(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  source_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  source_refs_json TEXT,
  render_state TEXT NOT NULL CHECK(render_state IN ('draft', 'source_ready', 'rendering', 'ready', 'failed')),
  output_media_id TEXT REFERENCES media_objects(id) ON DELETE SET NULL,
  render_error TEXT,
  render_attempt_id TEXT,
  render_attempt_expires_at TEXT,
  render_attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_rev_doc_num
  ON document_revisions(document_id, revision_number);

CREATE INDEX IF NOT EXISTS idx_doc_rev_render_due
  ON document_revisions(render_state, render_attempt_expires_at);
