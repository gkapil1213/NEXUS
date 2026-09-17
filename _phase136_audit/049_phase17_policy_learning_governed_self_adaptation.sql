BEGIN;

-- Immutable policy versions
CREATE TABLE IF NOT EXISTS policy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  parent_version TEXT,
  policy_definition TEXT NOT NULL,        -- JSON
  status TEXT NOT NULL DEFAULT 'PROPOSED', -- PROPOSED, GOVERNED, AUTHORIZED, ROLLOUT, ACTIVE, SUPERSEDED, ROLLED_BACK, REJECTED
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  correlation_id TEXT,
  UNIQUE(tenant_id, policy_id, policy_version)
);

-- Evidence (append-only)
CREATE TABLE IF NOT EXISTS policy_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  decision_id TEXT,
  observation_window_start TEXT,
  observation_window_end TEXT,
  telemetry_summary TEXT NOT NULL,        -- JSON, redacted
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  rollback_count INTEGER NOT NULL DEFAULT 0,
  latency_summary TEXT,
  cost_summary TEXT,
  reliability_summary TEXT,
  incident_summary TEXT,
  redacted_input TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, policy_id, policy_version, correlation_id)  -- idempotency
);

-- Effectiveness evaluations (latest per version)
CREATE TABLE IF NOT EXISTS policy_effectiveness (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  effectiveness TEXT NOT NULL,            -- EFFECTIVE, DEGRADED, INEFFECTIVE, INSUFFICIENT_DATA
  metrics_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
  correlation_id TEXT,
  UNIQUE(tenant_id, policy_id, policy_version, correlation_id)
);

-- Drift detections
CREATE TABLE IF NOT EXISTS policy_drift (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  drift_state TEXT NOT NULL,              -- NO_DRIFT, LOW_DRIFT, MODERATE_DRIFT, HIGH_DRIFT, CRITICAL_DRIFT, INSUFFICIENT_DATA, UNKNOWN
  metrics_json TEXT NOT NULL,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  correlation_id TEXT,
  UNIQUE(tenant_id, policy_id, policy_version, correlation_id)
);

-- Learning proposals
CREATE TABLE IF NOT EXISTS policy_learning_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  proposed_version TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_ids TEXT,                      -- JSON array
  confidence TEXT NOT NULL,
  risk TEXT NOT NULL,
  expected_impact TEXT,
  rollback_plan TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  correlation_id TEXT
);

-- Rollout state (may already exist; if not, create)
CREATE TABLE IF NOT EXISTS policy_rollouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rollout_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  stage TEXT NOT NULL,                    -- OBSERVE_ONLY, CANARY, LIMITED, PROGRESSIVE, FULL, HOLD, PAUSED, ROLLED_BACK
  start_time TEXT NOT NULL,
  telemetry_window_start TEXT,
  telemetry_window_end TEXT,
  metrics_json TEXT,
  decision_id TEXT,
  correlation_id TEXT,
  UNIQUE(tenant_id, policy_id, policy_version, stage)
);

-- Outcomes
CREATE TABLE IF NOT EXISTS policy_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  previous_version TEXT NOT NULL,
  new_version TEXT NOT NULL,
  outcome TEXT NOT NULL,                  -- IMPROVED, NEUTRAL, DEGRADED, REGRESSED, UNKNOWN
  comparison_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  correlation_id TEXT,
  UNIQUE(tenant_id, policy_id, previous_version, new_version, correlation_id)
);

-- Audit events (append-only)
CREATE TABLE IF NOT EXISTS policy_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  decision_id TEXT,
  policy_id TEXT NOT NULL,
  policy_version TEXT,
  event_type TEXT NOT NULL,
  actor TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  result TEXT,
  reason TEXT,
  redacted_metadata TEXT,
  UNIQUE(tenant_id, correlation_id, event_type, timestamp)
);

COMMIT;