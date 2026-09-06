-- Phase 50: Autonomous Compliance Assurance & Continuous Control Validation

CREATE TABLE IF NOT EXISTS compliance_frameworks_phase50 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    jurisdiction TEXT,
    control_families TEXT,
    controls TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS compliance_controls_phase50 (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    framework_id TEXT,
    requirement TEXT,
    description TEXT,
    severity TEXT NOT NULL DEFAULT 'medium',
    owner TEXT,
    evaluation_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_requirements TEXT,
    remediation_requirements TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (framework_id) REFERENCES compliance_frameworks_phase50(id)
);

CREATE TABLE IF NOT EXISTS compliance_requirements_phase50 (
    id TEXT PRIMARY KEY,
    framework_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL DEFAULT 'medium',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (framework_id) REFERENCES compliance_frameworks_phase50(id)
);

CREATE TABLE IF NOT EXISTS compliance_control_mappings_phase50 (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    requirement_id TEXT,
    resource_id TEXT,
    service_id TEXT,
    mapping_type TEXT NOT NULL DEFAULT 'direct',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(control_id, requirement_id, resource_id, service_id)
);

CREATE TABLE IF NOT EXISTS compliance_observations_phase50 (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    resource_id TEXT,
    service_id TEXT,
    observed_value TEXT,
    expected_value TEXT,
    observation_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    provider TEXT,
    evaluation_result TEXT,
    confidence REAL,
    evidence_ref TEXT,
    correlation_id TEXT,
    lineage_id TEXT
);

CREATE TABLE IF NOT EXISTS compliance_evaluations_phase50 (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    evaluation_state TEXT NOT NULL DEFAULT 'unknown',
    reason TEXT,
    evidence TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    evaluator TEXT,
    confidence REAL,
    policy_reference TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS compliance_effectiveness_phase50 (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    effectiveness_score REAL,
    stability_score REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_posture_phase50 (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    posture_state TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS compliance_drift_events_phase50 (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    drift_type TEXT NOT NULL,
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    state TEXT NOT NULL DEFAULT 'open',
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS compliance_policy_drift_phase50 (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    drift_details TEXT,
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS compliance_violations_phase50 (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    policy_id TEXT,
    service_id TEXT,
    resource_id TEXT,
    severity TEXT NOT NULL DEFAULT 'medium',
    risk_level TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    first_detected TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_detected TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    evidence TEXT,
    root_cause TEXT,
    correlated_change TEXT,
    remediation_status TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS compliance_risk_assessments_phase50 (
    id TEXT PRIMARY KEY,
    violation_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'unknown',
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_remediation_plans_phase50 (
    id TEXT PRIMARY KEY,
    violation_id TEXT NOT NULL,
    objective TEXT,
    steps_json TEXT,
    dependencies TEXT,
    expected_outcome TEXT,
    risk TEXT,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    approval_requirement TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_remediation_executions_phase50 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_verifications_phase50 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_regressions_phase50 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    regression_type TEXT NOT NULL,
    detected INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_rollbacks_phase50 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_circuit_breakers_phase50 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_incidents_phase50 (
    id TEXT PRIMARY KEY,
    violation_id TEXT,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_escalations_phase50 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_evidence_phase50 (
    id TEXT PRIMARY KEY,
    control_id TEXT,
    observation_id TEXT,
    evaluation_id TEXT,
    source TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    hash_fingerprint TEXT,
    lineage_id TEXT,
    actor TEXT,
    decision TEXT
);

CREATE TABLE IF NOT EXISTS compliance_audit_events_phase50 (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    resource TEXT,
    decision TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_lineage_phase50 (
    id TEXT PRIMARY KEY,
    policy_id TEXT,
    requirement_id TEXT,
    control_id TEXT,
    observation_id TEXT,
    evaluation_id TEXT,
    violation_id TEXT,
    remediation_plan_id TEXT,
    execution_id TEXT,
    verification_id TEXT,
    rollback_id TEXT,
    incident_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_learning_phase50 (
    id TEXT PRIMARY KEY,
    violation_id TEXT,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase50_frameworks_name ON compliance_frameworks_phase50(name);
CREATE INDEX idx_phase50_controls_framework ON compliance_controls_phase50(framework_id);
CREATE INDEX idx_phase50_violations_control ON compliance_violations_phase50(control_id);
CREATE INDEX idx_phase50_executions_plan ON compliance_remediation_executions_phase50(plan_id);
