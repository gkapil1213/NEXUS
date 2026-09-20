-- 156_phase165_execution_outcome_provenance.sql
-- Phase 165: durable execution outcome provenance.
--
-- Phase 164 established that one authoritative terminal outcome wins per
-- execution. This migration adds a first-class durable provenance record so
-- control-plane code and audits can answer "why was this outcome accepted"
-- without multi-table joins across execution_attempts and execution_events.
--
-- The row is written atomically inside ExecutionStore.completeAttemptAnd-
-- TransitionJob's existing transaction. No UPDATE or DELETE path exists, so
-- provenance is immutable by construction.
--
-- predecessor_attempt_id captures durable retry lineage for the same job.
-- recovery_operation_id captures the recovery operation (if any) that
-- participated in the terminalization. Both are optional.
--
-- evidence_hash is a deterministic SHA-256 over the canonical payload
--   JSON.stringify({ outcome, previous_state, attempt_id,
--                    evidence_json, terminalized_at })
-- so replaying identical evidence yields the identical hash, and any change
-- to the evidence is detectable. Uses node:crypto, matching the existing
-- artifact-signing.ts SHA-256 convention. No CHECK constraints; validity is
-- enforced by the TypeScript union, matching migrations 152-154.

CREATE TABLE IF NOT EXISTS execution_outcome_provenance (
  provenance_id          TEXT PRIMARY KEY,
  job_id                 TEXT NOT NULL,
  attempt_id             TEXT NOT NULL,
  attempt_number         INTEGER NOT NULL,
  outcome                TEXT NOT NULL,
  previous_state         TEXT NOT NULL,
  worker_id              TEXT,
  lease_id               TEXT,
  recovery_operation_id  TEXT,
  predecessor_attempt_id TEXT,
  reason                 TEXT,
  evidence_json          TEXT,
  evidence_hash          TEXT NOT NULL,
  terminalized_at        INTEGER NOT NULL,
  created_at             INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eop_attempt
  ON execution_outcome_provenance(attempt_id);

CREATE INDEX IF NOT EXISTS idx_eop_job
  ON execution_outcome_provenance(job_id, terminalized_at);

CREATE INDEX IF NOT EXISTS idx_eop_recovery
  ON execution_outcome_provenance(recovery_operation_id);

CREATE INDEX IF NOT EXISTS idx_eop_predecessor
  ON execution_outcome_provenance(predecessor_attempt_id);
