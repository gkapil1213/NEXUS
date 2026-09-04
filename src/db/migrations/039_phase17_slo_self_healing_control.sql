-- Phase 17.18: SLO-Aware Autonomous Control, Self-Healing & Continuous Production Verification
CREATE TABLE IF NOT EXISTS worker_slo_definitions (
  slo_id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  metric TEXT NOT NULL,
  target REAL NOT NULL,
  window_ms INTEGER NOT NULL,
  criticality TEXT NOT NULL,
  policy_version INTEGER,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_sli_observations (
  observation_id TEXT PRIMARY KEY,
  slo_id TEXT NOT NULL,
  value REAL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  freshness TEXT,
  quality TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (slo_id) REFERENCES worker_slo_definitions(slo_id)
);

CREATE TABLE IF NOT EXISTS worker_error_budget_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  slo_id TEXT NOT NULL,
  budget REAL,
  consumed REAL,
  remaining REAL,
  burn_rate REAL,
  state TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (slo_id) REFERENCES worker_slo_definitions(slo_id)
);

CREATE TABLE IF NOT EXISTS worker_control_effectiveness (
  effectiveness_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT,
  expected_outcome TEXT,
  actual_outcome TEXT,
  classification TEXT,
  confidence REAL,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_control_regressions (
  regression_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  severity TEXT,
  metric TEXT,
  before_value REAL,
  after_value REAL,
  threshold REAL,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_self_healing_executions (
  healing_id TEXT PRIMARY KEY,
  incident_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  state TEXT NOT NULL,
  attempt INTEGER DEFAULT 1,
  result TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_recovery_verifications (
  verification_id TEXT PRIMARY KEY,
  healing_id TEXT NOT NULL,
  state TEXT NOT NULL,
  sli_state TEXT,
  slo_state TEXT,
  result TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (healing_id) REFERENCES worker_self_healing_executions(healing_id)
);

CREATE TABLE IF NOT EXISTS worker_control_loop_health (
  health_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  success_rate REAL,
  harm_rate REAL,
  rollback_rate REAL,
  oscillation_rate REAL,
  recovery_time REAL,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_control_freezes (
  freeze_id TEXT PRIMARY KEY,
  reason TEXT,
  scope TEXT,
  state TEXT NOT NULL,
  triggered_at INTEGER NOT NULL,
  released_at INTEGER,
  correlation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_slo_enabled ON worker_slo_definitions(enabled);
CREATE INDEX IF NOT EXISTS idx_sli_slo ON worker_sli_observations(slo_id);
CREATE INDEX IF NOT EXISTS idx_error_budget_slo ON worker_error_budget_evaluations(slo_id);
CREATE INDEX IF NOT EXISTS idx_effectiveness_action ON worker_control_effectiveness(action_id);
CREATE INDEX IF NOT EXISTS idx_healing_state ON worker_self_healing_executions(state);
CREATE INDEX IF NOT EXISTS idx_recovery_verification_healing ON worker_recovery_verifications(healing_id);
