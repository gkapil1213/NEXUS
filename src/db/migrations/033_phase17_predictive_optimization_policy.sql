-- Phase 17.12: Predictive Optimization, Policy Governance & Safe Autonomous Control
CREATE TABLE IF NOT EXISTS worker_policy_versions (
  policy_version_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(version)
);

CREATE TABLE IF NOT EXISTS worker_optimization_decisions (
  decision_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  reason TEXT,
  affected_worker_id TEXT,
  affected_job_id TEXT,
  policy_version INTEGER,
  correlation_id TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_capacity_forecasts (
  forecast_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  cpu_deficit REAL,
  memory_deficit REAL,
  disk_deficit REAL,
  concurrency_deficit INTEGER,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_resilience_states (
  state_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_control_actions (
  action_id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  target_id TEXT,
  state TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_active ON worker_policy_versions(active);
CREATE INDEX IF NOT EXISTS idx_optimization_created ON worker_optimization_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_capacity_forecast_created ON worker_capacity_forecasts(created_at);
CREATE INDEX IF NOT EXISTS idx_control_actions_idempotency ON worker_control_actions(idempotency_key);
