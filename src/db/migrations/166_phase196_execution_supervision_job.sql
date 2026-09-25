-- Migration 166: Phase 196 - durable execution supervision state.
--
-- Adds durable columns to execution_jobs for the supervision classifier
-- and the operator control plane. NULL means "not yet classified", which
-- preserves pre-Phase-196 behavior for every existing job.

ALTER TABLE execution_jobs ADD COLUMN supervision_state TEXT;
ALTER TABLE execution_jobs ADD COLUMN failure_class TEXT;
ALTER TABLE execution_jobs ADD COLUMN supervision_updated_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_exec_jobs_supervision
  ON execution_jobs (supervision_state, supervision_updated_at)
  WHERE supervision_state IS NOT NULL;
