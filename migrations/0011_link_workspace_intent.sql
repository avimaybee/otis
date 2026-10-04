-- 009A: link-code workspace intent for guided Telegram connection.
-- The deep-link issuer stores which workspace the member chose on web; the
-- redemption selects exactly that workspace after rechecking membership.
-- Nullable so legacy intent-free codes keep single-auto-select behavior.
-- Zero-downtime additive column; existing rows read NULL (no intent).
ALTER TABLE link_codes ADD COLUMN requested_workspace_id TEXT;
