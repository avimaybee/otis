-- Migration: 0009_thinking_controls.sql
-- Extension for thinking effort controls: chat thinking override and run thinking snapshot.

ALTER TABLE chats ADD COLUMN thinking_override_json TEXT;
ALTER TABLE agent_runs ADD COLUMN thinking_snapshot_json TEXT;
