-- Phase 17.20: Autonomous Reliability Orchestration, Cross-Domain Recovery & Continuous Production Assurance
CREATE TABLE IF NOT EXISTS reliability_incidents (
  incident_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  root_cause_id TEXT,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reliability_correlations (
  correlation_id TEXT PRIMARY KEY,
  incident_ids TEXT NOT NULL,
  correlation_type TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reliability_root_causes (
  root_cause_id TEXT PRIMARY KEY,
  primary_cause TEXT NOT NULL,
  secondary_causes TEXT,
  confidence REAL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cross_domain_health (
  health_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_strategies (
  strategy_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  score REAL,
  risk_level TEXT,
  confidence REAL,
  blast_radius TEXT,
  reasons TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES reliability_incidents(incident_id)
);

CREATE TABLE IF NOT EXISTS recovery_plans (
  recovery_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  correlation_id TEXT,
  strategy TEXT NOT NULL,
  risk_level TEXT,
  blast_radius TEXT,
  confidence REAL,
  state TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES reliability_incidents(incident_id)
);

CREATE TABLE IF NOT EXISTS recovery_executions (
  execution_id TEXT PRIMARY KEY,
  recovery_id TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (recovery_id) REFERENCES recovery_plans(recovery_id)
);

CREATE TABLE IF NOT EXISTS recovery_verifications (
  verification_id TEXT PRIMARY KEY,
  recovery_id TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (recovery_id) REFERENCES recovery_plans(recovery_id)
);

CREATE TABLE IF NOT EXISTS recovery_outcomes (
  outcome_id TEXT PRIMARY KEY,
  recovery_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  effectiveness REAL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (recovery_id) REFERENCES recovery_plans(recovery_id)
);

CREATE TABLE IF NOT EXISTS recovery_regressions (
  regression_id TEXT PRIMARY KEY,
  recovery_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (recovery_id) REFERENCES recovery_plans(recovery_id)
);

CREATE TABLE IF NOT EXISTS recovery_budgets (
  budget_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  action_count INTEGER DEFAULT 0,
  max_actions INTEGER,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assurance_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autonomy_state (
  state_id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reliability_incidents_correlation ON reliability_incidents(correlation_id);
CREATE INDEX IF NOT EXISTS idx_recovery_plans_incident ON recovery_plans(incident_id);
CREATE INDEX IF NOT EXISTS idx_recovery_executions_recovery ON recovery_executions(recovery_id);
CREATE INDEX IF NOT EXISTS idx_recovery_verifications_recovery ON recovery_verifications(recovery_id);
CREATE INDEX IF NOT EXISTS idx_recovery_outcomes_recovery ON recovery_outcomes(recovery_id);
CREATE INDEX IF NOT EXISTS idx_recovery_budgets_scope ON recovery_budgets(scope);
