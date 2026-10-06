-- Migration: 0016_brief_next_due.sql
-- Due-aware brief sweep: persist the next UTC instant at which a member's
-- schedule becomes runnable so the cron selects only due members instead of
-- reading every enabled schedule. Additive only (nullable column, no
-- rebuild): legacy rows stay NULL and are evaluated once, then stamped.
-- The stamp is recomputed on schedule edits (reset to NULL) and after every
-- committed sweep outcome. It is selection state, never schedule truth.

ALTER TABLE member_settings ADD COLUMN brief_next_due_utc TEXT;

CREATE INDEX IF NOT EXISTS idx_member_settings_brief_due
  ON member_settings(brief_enabled, brief_next_due_utc);
