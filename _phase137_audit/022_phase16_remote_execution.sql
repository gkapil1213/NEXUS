-- Phase 16: Live Remote Worker and Real CI/CD Execution Layer
CREATE TABLE IF NOT EXISTS worker_sessions (
  session_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  nonce TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS remote_execution_results (
  result_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT,
  worker_id TEXT,
  dispatch_id TEXT,
  lease_id TEXT,
  success INTEGER NOT NULL,
  exit_code INTEGER,
  stdout_ref TEXT,
  stderr_ref TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_worker_sessions_worker ON worker_sessions(worker_id);
CREATE INDEX IF NOT EXISTS idx_remote_results_job ON remote_execution_results(job_id);
