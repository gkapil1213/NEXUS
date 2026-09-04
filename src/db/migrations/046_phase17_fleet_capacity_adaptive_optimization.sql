-- Phase 17.25: Autonomous Fleet Capacity Optimization & Adaptive Scaling Control
CREATE TABLE IF NOT EXISTS capacity_observations (
  observation_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  current_capacity REAL NOT NULL,
  utilized_capacity REAL NOT NULL,
  headroom REAL,
  state TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS capacity_forecasts (
  forecast_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  forecast_capacity REAL,
  horizon_ms INTEGER,
  confidence REAL,
  trend TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scaling_plans (
  plan_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  current_capacity REAL NOT NULL,
  target_capacity REAL NOT NULL,
  delta REAL NOT NULL,
  strategy TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  confidence REAL NOT NULL,
  safety_decision TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scaling_decisions (
  decision_id TEXT PRIMARY KEY,
  plan_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  policy_version INTEGER,
  confidence REAL,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES scaling_plans(plan_id)
);

CREATE TABLE IF NOT EXISTS scaling_outcomes (
  outcome_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  effectiveness TEXT,
  slo_impact TEXT,
  reliability_impact TEXT,
  utilization_impact REAL,
  regression_detected INTEGER DEFAULT 0,
  rollback_required INTEGER DEFAULT 0,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES scaling_plans(plan_id)
);

CREATE INDEX IF NOT EXISTS idx_capacity_observations_target ON capacity_observations(target_id);
CREATE INDEX IF NOT EXISTS idx_capacity_forecasts_target ON capacity_forecasts(target_id);
CREATE INDEX IF NOT EXISTS idx_scaling_plans_status ON scaling_plans(status);
CREATE INDEX IF NOT EXISTS idx_scaling_outcomes_plan ON scaling_outcomes(plan_id);
