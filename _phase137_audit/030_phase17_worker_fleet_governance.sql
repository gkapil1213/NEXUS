-- Phase 17.9: Worker Fleet Governance, Scheduling & Capacity Control
CREATE TABLE IF NOT EXISTS worker_fleet_state (
  worker_id TEXT PRIMARY KEY,
  region TEXT,
  environment TEXT,
  os TEXT,
  architecture TEXT,
  runtime_version TEXT,
  labels TEXT,
  cpu_capacity REAL,
  memory_capacity REAL,
  disk_capacity REAL,
  concurrency_limit INTEGER,
  active_jobs INTEGER DEFAULT 0,
  queued_jobs INTEGER DEFAULT 0,
  draining INTEGER DEFAULT 0,
  maintenance INTEGER DEFAULT 0,
  last_heartbeat_at INTEGER,
  last_seen_at INTEGER,
  last_job_at INTEGER,
  failure_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS worker_capacity_reservations (
  reservation_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  lease_id TEXT,
  cpu REAL,
  memory REAL,
  disk REAL,
  concurrency INTEGER DEFAULT 1,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  released_at INTEGER,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id),
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS scheduler_queue (
  job_id TEXT PRIMARY KEY,
  priority TEXT NOT NULL,
  deadline INTEGER,
  requirements TEXT,
  status TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  scheduling_attempts INTEGER DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS scheduler_decisions (
  decision_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  rejection_reasons TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_worker_fleet_region ON worker_fleet_state(region);
CREATE INDEX IF NOT EXISTS idx_worker_fleet_environment ON worker_fleet_state(environment);
CREATE INDEX IF NOT EXISTS idx_reservations_worker ON worker_capacity_reservations(worker_id);
CREATE INDEX IF NOT EXISTS idx_reservations_job ON worker_capacity_reservations(job_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_status ON scheduler_queue(status);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_job ON scheduler_decisions(job_id);
