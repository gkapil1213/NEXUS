-- Phase 83: Predictive Failure Prevention & Autonomous Preventive Engineering
BEGIN;

CREATE TABLE IF NOT EXISTS predictive_signals (
    id TEXT PRIMARY KEY,
    signal_type TEXT NOT NULL,
    source TEXT,
    entity_id TEXT,
    observed_value REAL,
    baseline REAL,
    deviation REAL,
    confidence REAL,
    provenance TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_features (
    id TEXT PRIMARY KEY,
    signal_id TEXT REFERENCES predictive_signals(id),
    feature_name TEXT NOT NULL,
    feature_value REAL,
    trend REAL,
    provenance TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_predictions (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    target_entity TEXT,
    risk_score REAL,
    confidence TEXT NOT NULL DEFAULT 'UNKNOWN',
    time_horizon TEXT,
    severity TEXT,
    expected_impact TEXT,
    causal_context TEXT,
    graph_context TEXT,
    model_version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictive_prediction_evidence (
    id TEXT PRIMARY KEY,
    prediction_id TEXT NOT NULL REFERENCES predictive_predictions(id),
    evidence_type TEXT,
    evidence_ref TEXT,
    support_strength REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_confidence (
    id TEXT PRIMARY KEY,
    prediction_id TEXT NOT NULL REFERENCES predictive_predictions(id),
    confidence TEXT NOT NULL,
    evidence_quality REAL,
    sample_size INTEGER,
    freshness TEXT,
    consistency REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_calibration (
    id TEXT PRIMARY KEY,
    prediction_id TEXT NOT NULL REFERENCES predictive_predictions(id),
    actual_outcome TEXT,
    expected_event TEXT,
    horizon TEXT,
    false_positive INTEGER NOT NULL DEFAULT 0,
    false_negative INTEGER NOT NULL DEFAULT 0,
    true_positive INTEGER NOT NULL DEFAULT 0,
    true_negative INTEGER NOT NULL DEFAULT 0,
    calibration_quality REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_drift (
    id TEXT PRIMARY KEY,
    prediction_id TEXT,
    drift_type TEXT NOT NULL,
    details TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_early_warnings (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    threshold REAL,
    current_value REAL,
    baseline REAL,
    trend REAL,
    confidence REAL,
    affected_scope TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_time_to_impact (
    id TEXT PRIMARY KEY,
    prediction_id TEXT NOT NULL REFERENCES predictive_predictions(id),
    estimated_time_seconds REAL,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_impacts (
    id TEXT PRIMARY KEY,
    prediction_id TEXT NOT NULL REFERENCES predictive_predictions(id),
    affected_workloads TEXT,
    affected_projects TEXT,
    affected_environments TEXT,
    affected_fleets TEXT,
    affected_regions TEXT,
    blast_radius REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preventive_action_candidates (
    id TEXT PRIMARY KEY,
    prediction_id TEXT NOT NULL REFERENCES predictive_predictions(id),
    action_type TEXT NOT NULL,
    target TEXT,
    expected_benefit TEXT,
    cost REAL,
    risk REAL,
    reversibility REAL,
    blast_radius REAL,
    historical_effectiveness REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preventive_action_scores (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES preventive_action_candidates(id),
    score REAL,
    objective_scores TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preventive_simulations (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES preventive_action_candidates(id),
    result TEXT NOT NULL DEFAULT 'INCONCLUSIVE',
    expected_outcome TEXT,
    resource_impact REAL,
    cost_impact REAL,
    blast_radius REAL,
    rollback_behavior TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preventive_approvals (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES preventive_action_candidates(id),
    approver TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(candidate_id)
);

CREATE TABLE IF NOT EXISTS preventive_canaries (
    id TEXT PRIMARY KEY,
    action_id TEXT,
    candidate_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    scope_subset TEXT,
    observed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preventive_actions (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES preventive_action_candidates(id),
    state TEXT NOT NULL DEFAULT 'PLANNED',
    executed_at TEXT,
    verification_state TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preventive_verifications (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES preventive_actions(id),
    result TEXT NOT NULL DEFAULT 'UNKNOWN',
    verified_at TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictive_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS predictive_rate_limits (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    max_actions INTEGER NOT NULL DEFAULT 1,
    window_seconds INTEGER NOT NULL DEFAULT 60,
    used_actions INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS predictive_escalations (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    reason TEXT,
    level TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pred_signal_type ON predictive_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_pred_pred_category ON predictive_predictions(category);
CREATE INDEX IF NOT EXISTS idx_pred_candidate_pred ON preventive_action_candidates(prediction_id);
CREATE INDEX IF NOT EXISTS idx_pred_breaker_scope ON predictive_breakers(scope, entity_id);

COMMIT;