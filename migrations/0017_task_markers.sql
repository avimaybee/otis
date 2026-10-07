-- Migration: 0017_task_markers.sql
-- Task selection markers: persist the explicit no-deadline choice and the
-- explicit promise marker so the brief kernel ranks undated next actions
-- and promised work from stored truth instead of hardcoded false.
-- Additive only with stable defaults matching historical behavior (dated
-- ranking, task reason): pre-existing rows read as dated-style tasks and
-- rebuilds reproduce them from event payloads, which now carry both flags.
-- Event payloads stay backward compatible: old task_created rows without
-- the flags reduce to false, exactly as before.

ALTER TABLE tasks ADD COLUMN explicit_no_deadline INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN is_promise INTEGER NOT NULL DEFAULT 0;
