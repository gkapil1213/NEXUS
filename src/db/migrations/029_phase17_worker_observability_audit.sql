-- Phase 17.8: Worker Observability, Telemetry & Audit Integrity
CREATE TABLE IF NOT EXISTS worker_telemetry_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  session_id TEXT,
  job_id TEXT,
  attempt_id TEXT,
  dispatch_id TEXT,
  lease_id TEXT,
  credential_id TEXT,
  artifact_id TEXT,
  result_id TEXT,
  recovery_id TEXT,
  correlation_id TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS worker_audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  worker_id TEXT,
  session_id TEXT,
  job_id TEXT,
  attempt_id TEXT,
  dispatch_id TEXT,
  lease_id TEXT,
  credential_id TEXT,
  artifact_id TEXT,
  result_id TEXT,
  recovery_id TEXT,
  correlation_id TEXT,
  payload TEXT,
  previous_event_hash TEXT,
  event_hash TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_telemetry_worker ON worker_telemetry_events(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_telemetry_job ON worker_telemetry_events(job_id);
CREATE INDEX IF NOT EXISTS idx_worker_telemetry_event_type ON worker_telemetry_events(event_type);
CREATE INDEX IF NOT EXISTS idx_worker_telemetry_timestamp ON worker_telemetry_events(timestamp);

CREATE INDEX IF NOT EXISTS idx_worker_audit_worker ON worker_audit_events(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_audit_event_type ON worker_audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_worker_audit_timestamp ON worker_audit_events(timestamp);
