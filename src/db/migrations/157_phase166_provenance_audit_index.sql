-- 157_phase166_provenance_audit_index.sql
-- Phase 166 - durable audit trail query index.

CREATE INDEX IF NOT EXISTS idx_eop_job_terminalized
  ON execution_outcome_provenance(job_id, terminalized_at);
