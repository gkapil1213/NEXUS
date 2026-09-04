-- Phase 13: Durable Execution, Worker, Lease, Artifact, Release, Deployment
CREATE TABLE IF NOT EXISTS execution_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  job_type TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL,
  retry_policy TEXT,
  timeout_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER,
  current_lease_id TEXT,
  cancellation_requested INTEGER DEFAULT 0,
  cancellation_acknowledged INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  worker_id TEXT,
  lease_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS execution_workers (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT,
  capabilities TEXT,
  status TEXT NOT NULL,
  last_heartbeat_at INTEGER,
  current_job_id TEXT,
  registered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_leases (
  lease_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER,
  released_at INTEGER,
  status TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS execution_artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id TEXT,
  release_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size_bytes INTEGER,
  checksum TEXT NOT NULL,
  storage_ref TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_releases (
  release_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  build_info TEXT,
  artifact_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_deployments (
  deployment_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rollback_deployment_id TEXT,
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS execution_approvals (
  approval_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (deployment_id) REFERENCES execution_deployments(deployment_id)
);

CREATE TABLE IF NOT EXISTS execution_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT,
  deployment_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON execution_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_next_attempt ON execution_jobs(next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_workers_status ON execution_workers(status);
CREATE INDEX IF NOT EXISTS idx_leases_status ON execution_leases(status);
CREATE INDEX IF NOT EXISTS idx_leases_job ON execution_leases(job_id);
