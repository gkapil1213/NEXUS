-- Migration 172: Phase 218 - remote_dispatches shared-mode mirror.
--
-- Mirrors the SQLite DDL used by ExecutionStore.addRemoteDispatch /
-- updateRemoteDispatch so that the production DispatchService path can
-- persist dispatch records in shared mode. Prior to this migration,
-- remote_dispatches existed only in SQLite while execution_jobs,
-- execution_attempts, execution_leases and execution_workers had already
-- been migrated to Postgres (Phase 183b). The FK on job_id therefore
-- failed as soon as a Postgres-persisted engineering.stage job was
-- dispatched (Phase 218).
--
-- Only job_id is constrained (matches the SQLite DDL). attempt_id,
-- worker_id, and lease_id remain unconstrained for backward compatibility.

CREATE TABLE IF NOT EXISTS remote_dispatches (
  dispatch_id           TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL,
  worker_id             TEXT NOT NULL,
  attempt_id            TEXT,
  lease_id              TEXT,
  status                TEXT NOT NULL,
  created_at            BIGINT NOT NULL,
  dispatched_at         BIGINT,
  completed_at          BIGINT,
  error                 TEXT,
  idempotency_key       TEXT UNIQUE NOT NULL,
  external_provider_id  TEXT,
  request               TEXT,
  result                TEXT,
  updated_at            BIGINT,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_remote_dispatches_job
  ON remote_dispatches(job_id);

CREATE INDEX IF NOT EXISTS idx_remote_dispatches_status
  ON remote_dispatches(status);
