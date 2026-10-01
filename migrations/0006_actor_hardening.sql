-- Migration: 0006_actor_hardening.sql
-- Gate 004B hardening: attempt-scoped step receipts so a stale attempt can
-- never overwrite its successor's receipts, and a durable answer source for
-- resumed clarifications. Forward-only. Existing rows keep NULL attempt
-- (adoptable) and NULL answer until rewritten by live traffic.

ALTER TABLE run_steps ADD COLUMN attempt_id TEXT;

ALTER TABLE pending_clarifications ADD COLUMN answer_message_id TEXT REFERENCES messages_in(id) ON DELETE SET NULL;
