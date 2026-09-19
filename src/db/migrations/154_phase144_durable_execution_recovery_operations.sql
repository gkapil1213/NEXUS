-- 154_phase144_durable_execution_recovery_operations.sql
-- Phase 144: durable execution recovery operations.
--
-- The authoritative durable record of a single recoverStaleJobs() recovery
-- attempt. Separate from worker_recovery_operations (Phase 17) and from
-- execution_ownership_obligations (Phase 126). One row per (job_id, lease_id,
-- operation_type) recovery identity; idempotency_key is the durable uniqueness
-- guard so concurrent createOrGetOperation calls converge on one row.
--
-- No CHECK constraint on state or operation_type. Validity is enforced by the
-- TypeScript union, matching migrations 152 and 153.

CREATE TABLE IF NOT EXISTS execution_recovery_operations (
  operation_id       TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  lease_id           TEXT,
  worker_id          TEXT,
  operation_type     TEXT NOT NULL,
  state              TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  claim_owner        TEXT,
  claim_expires_at   INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ero_idempotency_key
  ON execution_recovery_operations(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_ero_job_type
  ON execution_recovery_operations(job_id, operation_type);

CREATE INDEX IF NOT EXISTS idx_ero_state_updated
  ON execution_recovery_operations(state, updated_at);

CREATE INDEX IF NOT EXISTS idx_ero_claim_expires
  ON execution_recovery_operations(state, claim_expires_at);
