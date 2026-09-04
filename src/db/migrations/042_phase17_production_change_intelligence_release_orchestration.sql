-- Phase 17.21: Autonomous Production Change Intelligence, Safe Release Orchestration & Continuous Verification
CREATE TABLE IF NOT EXISTS production_changes (
  change_id TEXT PRIMARY KEY,
  change_type TEXT NOT NULL,
  service TEXT,
  target TEXT,
  actor TEXT,
  environment TEXT,
  failure_domain TEXT,
  risk_class TEXT,
  confidence REAL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS change_risk_assessments (
  risk_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  score REAL,
  reasons TEXT,
  confidence REAL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (change_id) REFERENCES production_changes(change_id)
);

CREATE TABLE IF NOT EXISTS release_plans (
  release_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  environment TEXT,
  state TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (change_id) REFERENCES production_changes(change_id)
);

CREATE TABLE IF NOT EXISTS release_executions (
  execution_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  adapter TEXT,
  state TEXT NOT NULL,
  result TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (release_id) REFERENCES release_plans(release_id)
);

CREATE TABLE IF NOT EXISTS release_canary_stages (
  stage_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  cohort REAL,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (release_id) REFERENCES release_plans(release_id)
);

CREATE TABLE IF NOT EXISTS release_verifications (
  verification_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (release_id) REFERENCES release_plans(release_id)
);

CREATE TABLE IF NOT EXISTS release_rollbacks (
  rollback_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (release_id) REFERENCES release_plans(release_id)
);

CREATE TABLE IF NOT EXISTS change_outcomes (
  outcome_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  release_id TEXT,
  classification TEXT NOT NULL,
  confidence REAL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (change_id) REFERENCES production_changes(change_id)
);

CREATE INDEX IF NOT EXISTS idx_production_changes_service ON production_changes(service);
CREATE INDEX IF NOT EXISTS idx_release_plans_state ON release_plans(state);
CREATE INDEX IF NOT EXISTS idx_release_executions_release ON release_executions(release_id);
CREATE INDEX IF NOT EXISTS idx_release_verifications_release ON release_verifications(release_id);
CREATE INDEX IF NOT EXISTS idx_change_outcomes_change ON change_outcomes(change_id);
