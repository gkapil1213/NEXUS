-- 173_phase242_recovery_retry_metadata.sql
-- Phase 242: durable retry metadata on execution recovery operations.
--
-- The Postgres schema already has next_attempt_at and last_failure_class via
-- an idempotent ALTER in pg-bootstrap.ts. This migration brings SQLite/local
-- mode to parity so the sync ExecutionRecoveryOperationStore can persist the
-- same retry metadata as the async store.
--
-- Idempotency is provided by MigrationRunner's nexus_schema_migrations
-- table (checksum-gated, applied at most once). SQLite has no
-- "ADD COLUMN IF NOT EXISTS", so this relies on the migration never
-- re-running against the same database.

ALTER TABLE execution_recovery_operations ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE execution_recovery_operations ADD COLUMN last_failure_class TEXT;

CREATE INDEX IF NOT EXISTS idx_ero_next_attempt
  ON execution_recovery_operations(state, next_attempt_at);