-- 144_durable_dispatch_intent.sql
-- Add index for idempotency lookups
CREATE INDEX IF NOT EXISTS idx_remote_dispatches_idempotency
ON remote_dispatches(idempotency_key);
