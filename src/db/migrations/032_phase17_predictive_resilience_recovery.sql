-- Phase 17.11: Predictive Worker Scheduling, Fleet Resilience & Autonomous Recovery Orchestration
CREATE TABLE IF NOT EXISTS worker_workload_forecasts (
  forecast_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  queue_depth INTEGER,
  growth_rate REAL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_reliability_assessments (
  assessment_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  reliability_state TEXT NOT NULL,
  evidence TEXT,
  evaluated_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS worker_risk_assessments (
  assessment_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  factors TEXT,
  evidence TEXT,
  evaluated_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS job_risk_assessments (
  assessment_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  factors TEXT,
  evidence TEXT,
  evaluated_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS worker_hotspots (
  hotspot_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence TEXT,
  detected_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS worker_recovery_operations (
  operation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT,
  state TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS worker_lease_anomalies (
  anomaly_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  evidence TEXT,
  detected_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_rebalance_decisions (
  decision_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  reasons TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workload_forecast_created ON worker_workload_forecasts(created_at);
CREATE INDEX IF NOT EXISTS idx_reliability_worker ON worker_reliability_assessments(worker_id);
CREATE INDEX IF NOT EXISTS idx_risk_worker ON worker_risk_assessments(worker_id);
CREATE INDEX IF NOT EXISTS idx_job_risk_job ON job_risk_assessments(job_id);
CREATE INDEX IF NOT EXISTS idx_hotspots_worker ON worker_hotspots(worker_id);
CREATE INDEX IF NOT EXISTS idx_recovery_ops_job ON worker_recovery_operations(job_id);
