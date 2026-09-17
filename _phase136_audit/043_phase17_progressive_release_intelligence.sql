-- Phase 17.22: Autonomous Release Intelligence, Progressive Delivery & Production Recovery
CREATE TABLE IF NOT EXISTS release_states (
  release_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  rollout_percentage REAL DEFAULT 0,
  previous_state TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_stage_history (
  history_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  from_stage REAL,
  to_stage REAL,
  reason TEXT,
  decision TEXT,
  epoch TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (release_id) REFERENCES release_states(release_id)
);

CREATE TABLE IF NOT EXISTS release_health_evaluations (
  health_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  health_state TEXT NOT NULL,
  slo_state TEXT,
  reliability_state TEXT,
  confidence REAL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_decisions (
  decision_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  confidence REAL,
  safety_result TEXT,
  epoch TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_canary_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  canary_state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_recovery_verifications (
  verification_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  recovery_state TEXT NOT NULL,
  result TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_suppression_state (
  release_id TEXT PRIMARY KEY,
  suppressed_until INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_states_state ON release_states(state);
CREATE INDEX IF NOT EXISTS idx_release_stage_history_release ON release_stage_history(release_id);
CREATE INDEX IF NOT EXISTS idx_release_health_release ON release_health_evaluations(release_id);
CREATE INDEX IF NOT EXISTS idx_release_decisions_release ON release_decisions(release_id);
CREATE INDEX IF NOT EXISTS idx_release_canary_release ON release_canary_evaluations(release_id);
