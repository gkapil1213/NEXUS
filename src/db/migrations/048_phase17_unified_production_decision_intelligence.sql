-- Phase 17.27: Autonomous Production Decision Intelligence & Unified Governance
CREATE TABLE IF NOT EXISTS unified_decisions (
  decision_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  selected_action TEXT,
  state TEXT NOT NULL,
  risk_level TEXT,
  confidence TEXT,
  governance_result TEXT,
  safety_result TEXT,
  authorization_result TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS unified_decision_candidates (
  candidate_id TEXT PRIMARY KEY,
  decision_id TEXT,
  controller TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  reason TEXT,
  expected_benefit TEXT,
  reliability_impact REAL,
  cost_impact REAL,
  risk_level TEXT,
  confidence TEXT,
  urgency INTEGER,
  reversibility TEXT,
  blast_radius TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES unified_decisions(decision_id)
);

CREATE TABLE IF NOT EXISTS unified_decision_conflicts (
  conflict_id TEXT PRIMARY KEY,
  decision_id TEXT,
  action_a TEXT NOT NULL,
  action_b TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES unified_decisions(decision_id)
);

CREATE TABLE IF NOT EXISTS unified_decision_executions (
  execution_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES unified_decisions(decision_id)
);

CREATE TABLE IF NOT EXISTS unified_decision_verifications (
  verification_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES unified_decisions(decision_id)
);

CREATE TABLE IF NOT EXISTS unified_decision_outcomes (
  outcome_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  evidence TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES unified_decisions(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_unified_decisions_state ON unified_decisions(state);
CREATE INDEX IF NOT EXISTS idx_unified_candidates_decision ON unified_decision_candidates(decision_id);
CREATE INDEX IF NOT EXISTS idx_unified_conflicts_decision ON unified_decision_conflicts(decision_id);
CREATE INDEX IF NOT EXISTS idx_unified_executions_decision ON unified_decision_executions(decision_id);
CREATE INDEX IF NOT EXISTS idx_unified_verifications_decision ON unified_decision_verifications(decision_id);
CREATE INDEX IF NOT EXISTS idx_unified_outcomes_decision ON unified_decision_outcomes(decision_id);
