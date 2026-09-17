-- Phase 17.23: Autonomous Production Change Governance, Continuous Verification & Fleet-Wide Release Control
CREATE TABLE IF NOT EXISTS production_change_assessments (
  assessment_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  confidence REAL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_waves (
  wave_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  wave_number INTEGER NOT NULL,
  components TEXT NOT NULL,
  state TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_wave_events (
  event_id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (wave_id) REFERENCES release_waves(wave_id)
);

CREATE TABLE IF NOT EXISTS continuous_verifications (
  verification_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS change_governance_decisions (
  decision_id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  confidence REAL,
  policy_version INTEGER,
  epoch TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_release_state (
  release_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  current_wave INTEGER,
  promoted_workers TEXT,
  blocked_workers TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prod_change_assessments_change ON production_change_assessments(change_id);
CREATE INDEX IF NOT EXISTS idx_release_waves_release ON release_waves(release_id);
CREATE INDEX IF NOT EXISTS idx_continuous_verifications_release ON continuous_verifications(release_id);
CREATE INDEX IF NOT EXISTS idx_governance_decisions_change ON change_governance_decisions(change_id);
