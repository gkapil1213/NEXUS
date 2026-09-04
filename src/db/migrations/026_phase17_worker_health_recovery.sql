-- Phase 17.5: Worker Health, Heartbeat, Lease & Self-Recovery Hardening
CREATE TABLE IF NOT EXISTS worker_health (
  worker_id TEXT PRIMARY KEY,
  health_state TEXT NOT NULL,
  last_heartbeat_at INTEGER,
  heartbeat_failures INTEGER DEFAULT 0,
  last_job_id TEXT,
  last_lease_id TEXT,
  detected_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS worker_health_events (
  event_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS worker_recovery_attempts (
  recovery_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  job_id TEXT,
  attempt_id TEXT,
  lease_id TEXT,
  reason TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  evidence TEXT,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id),
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_worker_health_state ON worker_health(health_state);
CREATE INDEX IF NOT EXISTS idx_worker_health_events_worker ON worker_health_events(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_recovery_attempts_worker ON worker_recovery_attempts(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_recovery_attempts_job ON worker_recovery_attempts(job_id);
