-- Migration: 0022_member_interpretation_timezone.sql
-- Device-reported IANA timezone per member per workspace, used to interpret
-- relative dates ("tomorrow", "next Friday") in the member's own zone. Kept
-- separate from brief_timezone, which drives brief delivery schedules and
-- must never be overwritten by device telemetry. NULL means unknown: the
-- agent keeps asking for timezone-sensitive deadlines instead of guessing.
ALTER TABLE member_settings ADD COLUMN interpretation_timezone TEXT;
