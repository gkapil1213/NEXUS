-- Migration 142: Production persistence and lease integrity
PRAGMA foreign_keys = ON;

-- Add partial unique index to enforce at most one ACTIVE lease per job
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_leases_active_job
ON execution_leases(job_id)
WHERE status = 'ACTIVE';
