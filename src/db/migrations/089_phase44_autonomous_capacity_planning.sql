-- Phase 44: Autonomous Capacity Planning, Resource Scaling & Infrastructure Optimization

CREATE TABLE IF NOT EXISTS capacity_resources_phase44 (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    environment TEXT,
    service_id TEXT,
    resource_type TEXT NOT NULL,
    region TEXT,
    zone TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    capacity REAL,
    allocated_capacity REAL,
    utilization REAL,
    owner TEXT,
    criticality TEXT NOT NULL DEFAULT 'unknown',
    config_fingerprint TEXT,
    version TEXT,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, resource_type, region, zone, service_id)
);

CREATE TABLE IF NOT EXISTS capacity_observations_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cpu_utilization REAL,
    memory_utilization REAL,
    storage_utilization REAL,
    network_utilization REAL,
    request_rate REAL,
    throughput REAL,
    latency_ms REAL,
    queue_depth REAL,
    connection_usage REAL,
    error_rate REAL,
    capacity_headroom REAL,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_assessments_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    capacity_state TEXT NOT NULL DEFAULT 'unknown',
    headroom REAL,
    assessed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_plans_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    current_capacity REAL,
    required_capacity REAL,
    recommended_capacity REAL,
    reason TEXT,
    forecast_basis TEXT,
    risk TEXT,
    expected_reliability_impact TEXT,
    expected_performance_impact TEXT,
    expected_cost_impact TEXT,
    governance_state TEXT,
    approval_requirement TEXT,
    safety_state TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_opportunities_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    opportunity_type TEXT NOT NULL,
    details TEXT,
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_optimizations_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    optimization_type TEXT NOT NULL,
    details TEXT,
    cost_savings_estimate REAL,
    reliability_impact TEXT,
    performance_impact TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_governance_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_approvals_phase44 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    approver TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    approved_at TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (plan_id) REFERENCES capacity_plans_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_safety_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    safe INTEGER NOT NULL DEFAULT 1,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_executions_phase44 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES capacity_plans_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_verifications_phase44 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES capacity_executions_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_rollbacks_phase44 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES capacity_executions_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_incidents_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_escalations_phase44 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES capacity_incidents_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_evidence_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_audit_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_lineage_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    observation_id TEXT,
    assessment_id TEXT,
    plan_id TEXT,
    execution_id TEXT,
    rollback_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_learning_phase44 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase44(id)
);

CREATE TABLE IF NOT EXISTS capacity_circuit_breakers_phase44 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase44_resources_provider ON capacity_resources_phase44(provider);
CREATE INDEX idx_phase44_observations_resource ON capacity_observations_phase44(resource_id);
CREATE INDEX idx_phase44_plans_resource ON capacity_plans_phase44(resource_id);
CREATE INDEX idx_phase44_executions_plan ON capacity_executions_phase44(plan_id);
