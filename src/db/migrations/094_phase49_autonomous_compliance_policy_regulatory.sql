-- Phase 49: Autonomous Compliance, Policy & Regulatory Operations Intelligence

CREATE TABLE IF NOT EXISTS compliance_frameworks_phase49 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    jurisdiction TEXT,
    effective_date TIMESTAMP,
    control_families TEXT,
    controls TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS compliance_policies_phase49 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    owner TEXT,
    scope TEXT,
    severity TEXT NOT NULL DEFAULT 'medium',
    enforcement_mode TEXT NOT NULL DEFAULT 'advisory',
    effective_status TEXT NOT NULL DEFAULT 'active',
    evaluation_criteria TEXT,
    associated_controls TEXT,
    associated_resources TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS compliance_controls_phase49 (
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
    FOREIGN KEY (framework_id) REFERENCES compliance_frameworks_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_assets_phase49 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    environment TEXT,
    owner TEXT,
    criticality TEXT NOT NULL DEFAULT 'unknown',
    protection_state TEXT NOT NULL DEFAULT 'unprotected',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_evidence_phase49 (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    asset_id TEXT,
    control_id TEXT,
    collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    validity_window TEXT,
    provenance TEXT,
    integrity_metadata TEXT,
    evidence_status TEXT NOT NULL DEFAULT 'collected',
    evaluator TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (asset_id) REFERENCES compliance_assets_phase49(id),
    FOREIGN KEY (control_id) REFERENCES compliance_controls_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_assessments_phase49 (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    asset_id TEXT,
    evidence_id TEXT,
    assessment_state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (control_id) REFERENCES compliance_controls_phase49(id),
    FOREIGN KEY (asset_id) REFERENCES compliance_assets_phase49(id),
    FOREIGN KEY (evidence_id) REFERENCES compliance_evidence_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_violations_phase49 (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    asset_id TEXT,
    severity TEXT NOT NULL DEFAULT 'medium',
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    state TEXT NOT NULL DEFAULT 'open',
    evidence_id TEXT,
    owner TEXT,
    risk_level TEXT,
    remediation_status TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (policy_id) REFERENCES compliance_policies_phase49(id),
    FOREIGN KEY (asset_id) REFERENCES compliance_assets_phase49(id),
    FOREIGN KEY (evidence_id) REFERENCES compliance_evidence_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_risk_phase49 (
    id TEXT PRIMARY KEY,
    violation_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'unknown',
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (violation_id) REFERENCES compliance_violations_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_mappings_phase49 (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    mapping_type TEXT NOT NULL DEFAULT 'regulatory',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, source_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS compliance_exceptions_phase49 (
    id TEXT PRIMARY KEY,
    policy_id TEXT,
    control_id TEXT,
    asset_id TEXT,
    justification TEXT,
    owner TEXT,
    risk_acceptance TEXT,
    expiration TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'pending',
    approval_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (policy_id) REFERENCES compliance_policies_phase49(id),
    FOREIGN KEY (control_id) REFERENCES compliance_controls_phase49(id),
    FOREIGN KEY (asset_id) REFERENCES compliance_assets_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_remediation_plans_phase49 (
    id TEXT PRIMARY KEY,
    violation_id TEXT NOT NULL,
    root_cause TEXT,
    proposed_action TEXT,
    affected_resources TEXT,
    dependencies TEXT,
    expected_outcome TEXT,
    risk TEXT,
    rollback_strategy TEXT,
    verification_criteria TEXT,
    approval_requirement TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (violation_id) REFERENCES compliance_violations_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_remediation_executions_phase49 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES compliance_remediation_plans_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_remediation_verifications_phase49 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES compliance_remediation_executions_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_remediation_rollbacks_phase49 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES compliance_remediation_executions_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_circuit_breakers_phase49 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_incidents_phase49 (
    id TEXT PRIMARY KEY,
    violation_id TEXT,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (violation_id) REFERENCES compliance_violations_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_escalations_phase49 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES compliance_incidents_phase49(id)
);

CREATE TABLE IF NOT EXISTS compliance_audit_phase49 (
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

CREATE TABLE IF NOT EXISTS compliance_lineage_phase49 (
    id TEXT PRIMARY KEY,
    framework_id TEXT,
    policy_id TEXT,
    control_id TEXT,
    asset_id TEXT,
    evidence_id TEXT,
    assessment_id TEXT,
    violation_id TEXT,
    remediation_plan_id TEXT,
    execution_id TEXT,
    verification_id TEXT,
    rollback_id TEXT,
    incident_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compliance_learning_phase49 (
    id TEXT PRIMARY KEY,
    violation_id TEXT,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (violation_id) REFERENCES compliance_violations_phase49(id)
);

CREATE INDEX idx_phase49_frameworks_name ON compliance_frameworks_phase49(name);
CREATE INDEX idx_phase49_policies_name ON compliance_policies_phase49(name);
CREATE INDEX idx_phase49_controls_framework ON compliance_controls_phase49(framework_id);
CREATE INDEX idx_phase49_violations_policy ON compliance_violations_phase49(policy_id);
CREATE INDEX idx_phase49_executions_plan ON compliance_remediation_executions_phase49(plan_id);