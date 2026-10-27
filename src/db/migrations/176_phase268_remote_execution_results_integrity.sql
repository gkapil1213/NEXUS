-- Phase 268: enforce indexes for remote execution result integrity.
-- Integrity columns are already introduced by migration 025.
-- Keep this migration additive and compatible with the existing SQLite schema.

CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_results_dispatch
  ON remote_execution_results(dispatch_id);

CREATE INDEX IF NOT EXISTS idx_remote_results_worker
  ON remote_execution_results(worker_id, created_at DESC);
