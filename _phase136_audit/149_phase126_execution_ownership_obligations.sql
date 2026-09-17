-- 149_phase126_execution_ownership_obligations.sql
-- Phase 126: durable ownership-loss obligations.
--
-- Written when a worker detects it no longer owns an execution lease:
--   - LeaseManager.renewLease(...) rejected (worker mismatch / expired)
--   - ExecutionStore.updateJobAsOwner(...) returned WORKER_OWNERSHIP_LOST
--   - ControlPlaneRecovery / ExecutionEngine.recoverStaleJobs classified a
--     stale execution that requires operator-visible recovery
--
-- Idempotent per (job_id, lease_id): repeated detection of the SAME
-- ownership loss converges on one row.  Terminal executions never produce
-- a new obligation.

CREATE TABLE IF NOT EXISTS execution_ownership_obligations (
  obligation_id TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  lease_id      TEXT NOT NULL,
  worker_id     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | RESOLVED
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolution    TEXT,
  UNIQUE (job_id, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_eoo_open
  ON execution_ownership_obligations (job_id)
  WHERE state = 'OPEN';