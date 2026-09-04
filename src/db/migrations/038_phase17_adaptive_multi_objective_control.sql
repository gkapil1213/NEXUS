-- Phase 17.17: Autonomous Multi-Objective Control, Adaptive Learning & Production Guardrails
CREATE TABLE IF NOT EXISTS worker_control_objectives (
  objective_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  weight REAL NOT NULL,
  direction TEXT NOT NULL,
  target REAL,
  threshold REAL,
  priority INTEGER NOT NULL,
  hard_constraint INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  policy_version INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(objective_id, version)
);

CREATE TABLE IF NOT EXISTS worker_control_objective_scores (
  score_id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  score REAL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (objective_id) REFERENCES worker_control_objectives(objective_id)
);

CREATE TABLE IF NOT EXISTS worker_adaptation_events (
  event_id TEXT PRIMARY KEY,
  parameter_path TEXT NOT NULL,
  old_value REAL,
  new_value REAL,
  reason TEXT,
  confidence REAL,
  policy_version INTEGER,
  learning_version INTEGER,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_adaptation_parameters (
  parameter_id TEXT PRIMARY KEY,
  parameter_path TEXT UNIQUE NOT NULL,
  current_value REAL NOT NULL,
  min_value REAL NOT NULL,
  max_value REAL NOT NULL,
  max_delta REAL NOT NULL,
  cooldown_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_learning_outcomes (
  outcome_id TEXT PRIMARY KEY,
  objective_id TEXT,
  expected_improvement REAL,
  actual_improvement REAL,
  success INTEGER DEFAULT 0,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (objective_id) REFERENCES worker_control_objectives(objective_id)
);

CREATE TABLE IF NOT EXISTS worker_learning_drift (
  drift_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_control_guardrails (
  guardrail_id TEXT PRIMARY KEY,
  guardrail_type TEXT NOT NULL,
  threshold REAL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_control_rollbacks (
  rollback_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  before_state TEXT,
  actual_state TEXT,
  rollback_status TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_control_health (
  health_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_objectives_enabled ON worker_control_objectives(enabled);
CREATE INDEX IF NOT EXISTS idx_adaptation_params_path ON worker_adaptation_parameters(parameter_path);
CREATE INDEX IF NOT EXISTS idx_adaptation_events_created ON worker_adaptation_events(created_at);
CREATE INDEX IF NOT EXISTS idx_rollback_action ON worker_control_rollbacks(action_id);
