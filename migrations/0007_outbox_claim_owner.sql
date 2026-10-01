-- Migration: 0007_outbox_claim_owner.sql
-- Gate 004B hardening pass 4: durable outbox ownership so a stale dispatcher
-- can never reset or count its successor's dispatch intent. Forward-only.

ALTER TABLE outbox ADD COLUMN claimed_by TEXT;
