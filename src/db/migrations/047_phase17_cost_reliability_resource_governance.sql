-- Phase 17.26: Autonomous Cost–Reliability Optimization & Resource Governance
CREATE TABLE IF NOT EXISTS resource_cost_observations (
  observation_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  cost REAL NOT NULL,
  cost_source TEXT NOT NULL,
  cost_confidence REAL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_cost_forecasts (
  forecast_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  forecast_cost REAL,
  trend TEXT NOT NULL,
  confidence REAL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_optimization_plans (
  optimization_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  current_state TEXT,
  target_state TEXT,
  candidate_action TEXT NOT NULL,
  expected_cost REAL,
  expected_savings REAL,
  expected_reliability_impact REAL,
  expected_performance_impact REAL,
  risk_level TEXT NOT NULL,
  confidence REAL,
  blast_radius TEXT,
  rollback_available INTEGER,
  safety_decision TEXT NOT NULL,
  status TEXT NOT NULL,
  policy_version INTEGER,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_optimization_executions (
  execution_id TEXT PRIMARY KEY,
  optimization_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (optimization_id) REFERENCES resource_optimization_plans(optimization_id)
);

CREATE TABLE IF NOT EXISTS resource_optimization_outcomes (
  outcome_id TEXT PRIMARY KEY,
  optimization_id TEXT NOT NULL,
  actual_cost REAL,
  expected_cost REAL,
  actual_reliability REAL,
  expected_reliability REAL,
  savings_realized REAL,
  savings_confidence REAL,
  classification TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (optimization_id) REFERENCES resource_optimization_plans(optimization_id)
);

CREATE TABLE IF NOT EXISTS resource_optimization_policies (
  policy_id TEXT PRIMARY KEY,
  maximum_cost REAL,
  minimum_reliability REAL,
  minimum_capacity_headroom REAL,
  maximum_change_risk TEXT,
  maximum_blast_radius TEXT,
  maximum_scaling_frequency INTEGER,
  minimum_observability_confidence REAL,
  rollback_required INTEGER,
  approval_required INTEGER,
  policy_version INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_optimization_regressions (
  regression_id TEXT PRIMARY KEY,
  optimization_id TEXT NOT NULL,
  regression_type TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (optimization_id) REFERENCES resource_optimization_plans(optimization_id)
);

CREATE TABLE IF NOT EXISTS resource_optimization_rollbacks (
  rollback_id TEXT PRIMARY KEY,
  optimization_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (optimization_id) REFERENCES resource_optimization_plans(optimization_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_cost_obs_resource ON resource_cost_observations(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_cost_forecasts_resource ON resource_cost_forecasts(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_opt_plans_status ON resource_optimization_plans(status);
CREATE INDEX IF NOT EXISTS idx_resource_opt_exec_opt ON resource_optimization_executions(optimization_id);
CREATE INDEX IF NOT EXISTS idx_resource_opt_outcomes_opt ON resource_optimization_outcomes(optimization_id);
