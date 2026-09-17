-- Phase 63: Autonomous Engineering Reliability Intelligence & Predictive Operations

CREATE TABLE IF NOT EXISTS reliability_signals_phase63 (
    id TEXT PRIMARY KEY,
    signal_type TEXT NOT NULL,
    source TEXT,
    environment_id TEXT,
    service_id TEXT,
    execution_id TEXT,
    release_id TEXT,
    deployment_id TEXT,
    incident_id TEXT,
    severity TEXT,
    observed_value REAL,
    baseline_value REAL,
    deviation REAL,
    confidence REAL DEFAULT 0,
    evidence_id TEXT,
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS reliability_baselines_phase63 (
    id TEXT PRIMARY KEY,
    metric TEXT NOT NULL,
    scope TEXT,
    environment_id TEXT,
    service_id TEXT,
    baseline_value REAL NOT NULL,
    sample_count INTEGER DEFAULT 0,
    window_start TIMESTAMP,
    window_end TIMESTAMP,
    methodology TEXT,
    confidence REAL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(metric, scope, environment_id, service_id)
);

CREATE TABLE IF NOT EXISTS reliability_assessments_phase63 (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    environment_id TEXT,
    reliability_score REAL,
    risk_level TEXT NOT NULL DEFAULT 'INSUFFICIENT_EVIDENCE',
    confidence REAL DEFAULT 0,
    evidence_count INTEGER DEFAULT 0,
    recurrence_probability REAL,
    regression_risk REAL,
    deployment_risk REAL,
    rollback_risk REAL,
    anomaly_detected INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS reliability_predictions_phase63 (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    prediction_type TEXT NOT NULL,
    score REAL,
    confidence REAL,
    horizon TEXT,
    evidence_reference TEXT,
    method TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS reliability_anomalies_phase63 (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'LOW',
    deviation REAL,
    confidence REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN',
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS reliability_recommendations_phase63 (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL,
    action TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    expected_risk_reduction REAL,
    confidence REAL DEFAULT 0,
    required_approval INTEGER DEFAULT 0,
    evidence_id TEXT,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS reliability_observations_phase63 (
    id TEXT PRIMARY KEY,
    recommendation_id TEXT NOT NULL,
    actual_outcome TEXT,
    expected_outcome TEXT,
    outcome_class TEXT NOT NULL DEFAULT 'INSUFFICIENT_EVIDENCE',
    deviation REAL,
    learning_reference TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_phase63_signals_env ON reliability_signals_phase63(environment_id);
CREATE INDEX idx_phase63_assessments_target ON reliability_assessments_phase63(target_id);
CREATE INDEX idx_phase63_recommendations_assessment ON reliability_recommendations_phase63(assessment_id);
