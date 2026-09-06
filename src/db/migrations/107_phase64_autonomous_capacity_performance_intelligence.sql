-- Phase 64: Autonomous Engineering Capacity Intelligence & Adaptive Performance Optimization

CREATE TABLE IF NOT EXISTS capacity_signals_phase64 (
    id TEXT PRIMARY KEY,
    signal_type TEXT NOT NULL,
    source TEXT,
    environment_id TEXT,
    service_id TEXT,
    execution_id TEXT,
    deployment_id TEXT,
    release_id TEXT,
    resource_type TEXT,
    resource_id TEXT,
    observed_value REAL,
    unit TEXT,
    baseline_value REAL,
    utilization_ratio REAL,
    confidence REAL DEFAULT 0,
    evidence_id TEXT,
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS capacity_baselines_phase64 (
    id TEXT PRIMARY KEY,
    metric TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    environment_id TEXT,
    service_id TEXT,
    resource_id TEXT,
    baseline_value REAL NOT NULL,
    unit TEXT,
    sample_count INTEGER DEFAULT 0,
    window_start TIMESTAMP,
    window_end TIMESTAMP,
    methodology TEXT,
    confidence REAL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(metric, target_type, target_id, environment_id, service_id, resource_id)
);

CREATE TABLE IF NOT EXISTS capacity_assessments_phase64 (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    environment_id TEXT,
    utilization REAL,
    headroom REAL,
    saturation_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    capacity_score REAL,
    performance_score REAL,
    confidence REAL DEFAULT 0,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    evidence_count INTEGER DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS performance_observations_phase64 (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    environment_id TEXT,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    baseline REAL,
    deviation REAL,
    aggregation_metadata TEXT,
    confidence REAL DEFAULT 0,
    evidence_id TEXT,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS performance_anomalies_phase64 (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    observed_value REAL,
    baseline_value REAL,
    deviation REAL,
    severity TEXT NOT NULL DEFAULT 'LOW',
    confidence REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN',
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS optimization_recommendations_phase64 (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    expected_effect TEXT,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    confidence REAL DEFAULT 0,
    required_approval INTEGER DEFAULT 0,
    verification_plan TEXT,
    evidence_id TEXT,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS optimization_observations_phase64 (
    id TEXT PRIMARY KEY,
    recommendation_id TEXT NOT NULL,
    expected_effect TEXT,
    actual_effect TEXT,
    deviation REAL,
    outcome_class TEXT NOT NULL DEFAULT 'INSUFFICIENT_EVIDENCE',
    learning_reference TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fingerprint TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_phase64_signals_env ON capacity_signals_phase64(environment_id);
CREATE INDEX idx_phase64_assessments_target ON capacity_assessments_phase64(target_id);
CREATE INDEX idx_phase64_recommendations_assessment ON optimization_recommendations_phase64(assessment_id);
