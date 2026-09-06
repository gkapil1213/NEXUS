-- Phase 43: Autonomous Observability, AIOps Intelligence & Predictive Operations

CREATE TABLE IF NOT EXISTS observability_sources_phase43 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_type TEXT NOT NULL,
    environment TEXT,
    owner TEXT,
    capabilities TEXT,
    health_state TEXT NOT NULL DEFAULT 'unknown',
    config_fingerprint TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telemetry_observations_phase43 (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    signal_type TEXT NOT NULL,
    service_id TEXT,
    resource_id TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    value_text TEXT,
    dimensions TEXT,
    severity TEXT,
    environment TEXT,
    correlation_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES observability_sources_phase43(id)
);

CREATE TABLE IF NOT EXISTS signal_fingerprints_phase43 (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    service_id TEXT,
    resource_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS behavior_baselines_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    baseline_value REAL,
    min_value REAL,
    max_value REAL,
    volatility REAL,
    trend_direction TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS anomalies_phase43 (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence REAL,
    evidence_refs TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trends_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    slope REAL,
    acceleration REAL,
    persistence REAL,
    confidence REAL,
    observation_window TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS predictions_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    predicted_condition TEXT NOT NULL,
    horizon TEXT,
    confidence REAL,
    uncertainty REAL,
    affected_resources TEXT,
    rationale TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS capacity_forecasts_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    current_observation REAL,
    forecast_value REAL,
    confidence REAL,
    uncertainty REAL,
    threshold_crossing_estimate TEXT,
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS topology_phase43 (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relationship TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, source_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS correlations_phase43 (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    correlation_strength TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS change_correlations_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    change_ref TEXT NOT NULL,
    correlation_strength TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL,
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS root_cause_hypotheses_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    candidate_cause TEXT NOT NULL,
    confidence REAL,
    supporting_evidence TEXT,
    contradictory_evidence TEXT,
    correlation_strength TEXT,
    explanation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS predictive_risk_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'unknown',
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS predictive_impact_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    affected_services TEXT,
    affected_resources TEXT,
    impact_estimate TEXT,
    blast_radius TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS preventive_remediation_plans_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    reason TEXT,
    evidence TEXT,
    expected_outcome TEXT,
    rollback_strategy TEXT,
    safety_requirement TEXT,
    approval_requirement TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS preventive_remediation_executions_phase43 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES preventive_remediation_plans_phase43(id)
);

CREATE TABLE IF NOT EXISTS preventive_remediation_verifications_phase43 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES preventive_remediation_executions_phase43(id)
);

CREATE TABLE IF NOT EXISTS preventive_remediation_rollbacks_phase43 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES preventive_remediation_executions_phase43(id)
);

CREATE TABLE IF NOT EXISTS remediation_circuit_breakers_phase43 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS predictive_incidents_phase43 (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence REAL,
    evidence TEXT,
    affected_resources TEXT,
    predicted_impact TEXT,
    root_cause_hypothesis TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS predictive_escalations_phase43 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES predictive_incidents_phase43(id)
);

CREATE TABLE IF NOT EXISTS observability_governance_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS observability_audit_phase43 (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    resource TEXT,
    decision TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS observability_evidence_phase43 (
    id TEXT PRIMARY KEY,
    source TEXT,
    finding_id TEXT,
    incident_id TEXT,
    execution_id TEXT,
    hash_fingerprint TEXT,
    payload_reference TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS observability_lineage_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    telemetry_id TEXT,
    anomaly_id TEXT,
    prediction_id TEXT,
    risk_id TEXT,
    plan_id TEXT,
    execution_id TEXT,
    rollback_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS observability_learning_phase43 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase43_sources_provider ON observability_sources_phase43(provider);
CREATE INDEX idx_phase43_telemetry_fingerprint ON telemetry_observations_phase43(fingerprint);
CREATE INDEX idx_phase43_anomalies_service ON anomalies_phase43(service_id);
CREATE INDEX idx_phase43_predictions_service ON predictions_phase43(service_id);
