-- 009A: Telegram delivery retry scheduling.
-- 429 flood-control responses carry a server retry_after; the due scan
-- must not reselect the row before then. Zero-downtime additive column;
-- existing rows read NULL (immediately due), same as before.
ALTER TABLE outbox ADD COLUMN next_retry_at TEXT;
