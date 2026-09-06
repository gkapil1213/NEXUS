-- Phase 47: Autonomous Capacity, Cost & Resource Optimization Intelligence

CREATE TABLE IF NOT EXISTS optimization_resources_phase47 (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    environment TEXT,
    region TEXT,
    zone TEXT,
    owner TEXT,
    team TEXT,
    service_id TEXT,
    project TEXT,
    criticality TEXT NOT NULL DEFAULT 'unknown',
    protection_state TEXT NOT NULL DEFAULT 'unprotected',
    status TEXT NOT NULL DEFAULT 'active',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, resource_type, region, zone, service_id)
);

CREATE TABLE IF NOT EXISTS optimization_resource_observations_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    confidence REAL,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_cost_observations_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    billing_period TEXT,
    provider TEXT,
    source TEXT,
    confidence REAL,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_cost_anomalies_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    evidence TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_capacity_findings_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    finding_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'unknown',
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_forecasts_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    horizon TEXT,
    predicted_value REAL,
    confidence REAL,
    evidence TEXT,
    model_method TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_opportunities_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    opportunity_type TEXT NOT NULL,
    current_state TEXT,
    proposed_state TEXT,
    expected_benefit TEXT,
    expected_savings REAL,
    reliability_impact TEXT,
    security_impact TEXT,
    blast_radius TEXT,
    confidence REAL,
    evidence TEXT,
    governance_requirement TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_risks_phase47 (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'unknown',
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (opportunity_id) REFERENCES optimization_opportunities_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_change_correlations_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    change_ref TEXT,
    correlation_strength TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_dependency_impacts_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    dependent_services TEXT,
    blast_radius TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_governance_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_approvals_phase47 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    approver TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    approved_at TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (plan_id) REFERENCES optimization_plans_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_safety_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    safe INTEGER NOT NULL DEFAULT 1,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_plans_phase47 (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    current_state TEXT,
    target_state TEXT,
    action_sequence TEXT,
    expected_benefit TEXT,
    expected_risk TEXT,
    blast_radius TEXT,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    governance_decision TEXT,
    approval_state TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (opportunity_id) REFERENCES optimization_opportunities_phase47(id),
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_executions_phase47 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES optimization_plans_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_verifications_phase47 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES optimization_executions_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_rollbacks_phase47 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES optimization_executions_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_circuit_breakers_phase47 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS optimization_incidents_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_escalations_phase47 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES optimization_incidents_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_evidence_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_audit_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_lineage_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    observation_id TEXT,
    finding_id TEXT,
    opportunity_id TEXT,
    plan_id TEXT,
    execution_id TEXT,
    rollback_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE TABLE IF NOT EXISTS optimization_learning_phase47 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES optimization_resources_phase47(id)
);

CREATE INDEX idx_phase47_resources_provider ON optimization_resources_phase47(provider);
CREATE INDEX idx_phase47_observations_resource ON optimization_resource_observations_phase47(resource_id);
CREATE INDEX idx_phase47_opportunities_resource ON optimization_opportunities_phase47(resource_id);
CREATE INDEX idx_phase47_executions_plan ON optimization_executions_phase47(plan_id);
