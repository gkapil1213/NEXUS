-- Phase 17.10: Worker Fleet Autoscaling, Backpressure & Admission Control
CREATE TABLE IF NOT EXISTS worker_admission_decisions (
  decision_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT,
  decision TEXT NOT NULL,
  reasons TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS worker_backpressure_state (
  fleet_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  queue_depth INTEGER,
  utilization REAL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_scaling_decisions (
  decision_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  reason TEXT,
  current_workers INTEGER,
  target_workers INTEGER,
  cooldown_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admission_job ON worker_admission_decisions(job_id);
CREATE INDEX IF NOT EXISTS idx_admission_worker ON worker_admission_decisions(worker_id);
CREATE INDEX IF NOT EXISTS idx_backpressure_state ON worker_backpressure_state(state);
CREATE INDEX IF NOT EXISTS idx_scaling_created ON worker_scaling_decisions(created_at);
