-- Phase 15: Remote Execution & Cloud/CI/CD Control Plane
CREATE TABLE IF NOT EXISTS remote_workers (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  platform TEXT,
  architecture TEXT,
  agent_version TEXT,
  capabilities TEXT,
  status TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER,
  current_job_id TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS remote_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  attempt_id TEXT,
  lease_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS remote_execution_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT,
  worker_id TEXT,
  dispatch_id TEXT,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cicd_providers (
  provider_id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cicd_runs (
  run_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_run_id TEXT,
  job_id TEXT,
  repository TEXT,
  ref TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS cicd_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT,
  provider_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_remote_workers_status ON remote_workers(status);
CREATE INDEX IF NOT EXISTS idx_remote_dispatches_job ON remote_dispatches(job_id);
CREATE INDEX IF NOT EXISTS idx_remote_events_job ON remote_execution_events(job_id);
CREATE INDEX IF NOT EXISTS idx_cicd_runs_provider ON cicd_runs(provider_id);
