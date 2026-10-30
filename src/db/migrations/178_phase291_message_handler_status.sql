-- Phase 291: durable handler lifecycle tracking for worker messages.
-- Extends worker_message_ids with lease-based handler ownership.
-- Applied once by MigrationRunner (filename-keyed, checksum-verified).
-- NOTE: does NOT begin with BEGIN; runner wraps in BEGIN IMMEDIATE.
ALTER TABLE worker_message_ids ADD COLUMN handler_status TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED';
ALTER TABLE worker_message_ids ADD COLUMN handler_owner_id TEXT;
ALTER TABLE worker_message_ids ADD COLUMN handler_claim_expires_at INTEGER;
ALTER TABLE worker_message_ids ADD COLUMN handler_started_at INTEGER;
ALTER TABLE worker_message_ids ADD COLUMN handler_completed_at INTEGER;
ALTER TABLE worker_message_ids ADD COLUMN handler_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worker_message_ids ADD COLUMN handler_last_error TEXT;
ALTER TABLE worker_message_ids ADD COLUMN handler_recovery_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_worker_message_ids_recoverable
  ON worker_message_ids (handler_status, seen_at)
  WHERE handler_status IN ('PENDING', 'PROCESSING');