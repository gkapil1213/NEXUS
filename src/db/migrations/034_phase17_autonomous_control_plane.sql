-- Phase 17.13: Autonomous Control-Plane Execution, Closed-Loop Optimization & Governance
CREATE TABLE IF NOT EXISTS control_decisions (
  decision_id TEXT PRIMARY KEY,
  objective_id TEXT,
  action_type TEXT NOT NULL,
  target_id TEXT,
  policy_version INTEGER,
  correlation_id TEXT,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  autonomy_level TEXT NOT NULL,
  reason TEXT,
  evidence TEXT,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER,
  decided_at INTEGER,
  executed_at INTEGER,
  completed_at INTEGER,
  idempotency_key TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS control_actions (
  action_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES control_decisions(decision_id)
);

CREATE TABLE IF NOT EXISTS control_objectives (
  objective_id TEXT PRIMARY KEY,
  objective_type TEXT NOT NULL,
  target_metric TEXT NOT NULL,
  target_value REAL,
  status TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS control_overrides (
  override_id TEXT PRIMARY KEY,
  override_type TEXT NOT NULL,
  target_scope TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS control_budgets (
  budget_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  action_count INTEGER DEFAULT 0,
  max_actions INTEGER,
  window_start INTEGER NOT NULL,
  window_end INTEGER
);

CREATE TABLE IF NOT EXISTS control_loop_state (
  loop_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  iteration_count INTEGER DEFAULT 0,
  max_iterations INTEGER,
  last_action_at INTEGER,
  cooldown_until INTEGER,
  evidence TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_control_decisions_status ON control_decisions(status);
CREATE INDEX IF NOT EXISTS idx_control_actions_decision ON control_actions(decision_id);
CREATE INDEX IF NOT EXISTS idx_control_actions_status ON control_actions(status);
CREATE INDEX IF NOT EXISTS idx_control_objectives_status ON control_objectives(status);
CREATE INDEX IF NOT EXISTS idx_control_overrides_type ON control_overrides(override_type);
