-- 155_phase147_attempt_number_uniqueness.sql
-- Phase 147: prevent duplicate authoritative attempt numbers per job.
--
-- migration 020 did not constrain (job_id, attempt_number). The live execution
-- engine derives attemptNumber as listAttemptsForJob(jobId).length + 1, which
-- is not concurrency-safe on its own. Lease/ownership fencing already gates
-- attempt writes in practice, but the durable record must enforce the
-- invariant as a database-level backstop.
--
-- Safety for existing installations: this migration will fail to apply if
-- duplicate rows already exist. Run the following before upgrading:
--   SELECT job_id, attempt_number, COUNT(*) FROM execution_attempts
--     GROUP BY job_id, attempt_number HAVING COUNT(*) > 1;
-- If that returns rows, resolve the duplicates first; do NOT delete historical
-- attempts blindly.

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attempts_job_number
  ON execution_attempts(job_id, attempt_number);
