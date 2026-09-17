-- Phase 17.19: Autonomous Reliability Intelligence, Healing Optimization & Preventive Control
CREATE TABLE IF NOT EXISTS reliability_scores (
  score_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS failure_signatures (
  signature_id TEXT PRIMARY KEY,
  signature TEXT UNIQUE NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  count INTEGER DEFAULT 1,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_patterns (
  pattern_id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL,
  signature_id TEXT,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (signature_id) REFERENCES failure_signatures(signature_id)
);

CREATE TABLE IF NOT EXISTS healing_effectiveness (
  effectiveness_id TEXT PRIMARY KEY,
  healing_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  recovery_time REAL,
  confidence REAL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preventive_recommendations (
  recommendation_id TEXT PRIMARY KEY,
  recommendation_type TEXT NOT NULL,
  target_id TEXT,
  confidence REAL,
  risk_level TEXT,
  state TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reliability_scores_scope ON reliability_scores(scope);
CREATE INDEX IF NOT EXISTS idx_failure_signatures_signature ON failure_signatures(signature);
CREATE INDEX IF NOT EXISTS idx_incident_patterns_type ON incident_patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_healing_effectiveness_healing ON healing_effectiveness(healing_id);
CREATE INDEX IF NOT EXISTS idx_preventive_recommendations_state ON preventive_recommendations(state);
