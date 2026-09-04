-- Phase 17.24: Autonomous Fleet-Wide Reliability Optimization, Change-Impact Learning & Closed-Loop Production Control
CREATE TABLE IF NOT EXISTS fleet_reliability_assessments (
  assessment_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  reliability_score REAL,
  state TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS change_impact_outcomes (
  outcome_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  impact_level TEXT NOT NULL,
  confidence REAL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dependency_impact_assessments (
  assessment_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  impact_scope TEXT NOT NULL,
  dependency_depth INTEGER,
  affected_domains TEXT,
  confidence REAL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blast_radius_assessments (
  assessment_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  blast_radius TEXT NOT NULL,
  confidence REAL,
  affected_services TEXT,
  affected_domains TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS control_decision_outcomes (
  outcome_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  service TEXT,
  change_id TEXT,
  release_id TEXT,
  expected_outcome TEXT,
  actual_outcome TEXT,
  classification TEXT NOT NULL,
  confidence REAL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS control_strategy_effectiveness (
  effectiveness_id TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  effectiveness_score REAL,
  confidence REAL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_drift_events (
  drift_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  drift_state TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_control_decisions (
  decision_id TEXT PRIMARY KEY,
  release_id TEXT,
  service TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  confidence REAL,
  policy_version INTEGER,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fleet_reliability_scope ON fleet_reliability_assessments(scope);
CREATE INDEX IF NOT EXISTS idx_change_impact_outcomes_change ON change_impact_outcomes(change_id);
CREATE INDEX IF NOT EXISTS idx_dependency_impact_change ON dependency_impact_assessments(change_id);
CREATE INDEX IF NOT EXISTS idx_blast_radius_change ON blast_radius_assessments(change_id);
CREATE INDEX IF NOT EXISTS idx_control_decision_outcomes_decision ON control_decision_outcomes(decision_id);
CREATE INDEX IF NOT EXISTS idx_strategy_effectiveness_strategy ON control_strategy_effectiveness(strategy);
CREATE INDEX IF NOT EXISTS idx_learning_drift_scope ON learning_drift_events(scope);
CREATE INDEX IF NOT EXISTS idx_fleet_control_decisions_release ON fleet_control_decisions(release_id);
