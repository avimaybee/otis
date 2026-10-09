-- Original PDF bytes use media_objects.content_type; format NULL preserves the
-- verified audio/image format enum without rebuilding a live media table.
CREATE TABLE document_extractions (
  media_id TEXT PRIMARY KEY REFERENCES media_objects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  checksum TEXT NOT NULL, extractor_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('pending','running','ready','needs_visual','failed')),
  attempt_id TEXT, attempt_expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
  result_key TEXT, chunks_json TEXT, error TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX idx_document_extractions_due ON document_extractions(state, attempt_expires_at);
CREATE TABLE reminder_rule_cursors (
  rule_id TEXT PRIMARY KEY REFERENCES reminder_rules(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_revision INTEGER NOT NULL, next_due TEXT, dirty INTEGER NOT NULL DEFAULT 1,
  last_delivered_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX idx_rule_cursors_due ON reminder_rule_cursors(next_due, dirty);
ALTER TABLE reminders ADD COLUMN rule_id TEXT;
ALTER TABLE reminders ADD COLUMN rule_revision INTEGER;
ALTER TABLE reminders ADD COLUMN occurrence_key TEXT;
ALTER TABLE reminders ADD COLUMN interaction_id TEXT;
ALTER TABLE reminders ADD COLUMN head_event_id TEXT;
CREATE UNIQUE INDEX idx_reminder_rule_occurrence ON reminders(rule_id, occurrence_key) WHERE rule_id IS NOT NULL;
