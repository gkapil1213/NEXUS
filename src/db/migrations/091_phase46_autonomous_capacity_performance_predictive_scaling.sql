-- Phase 46: Autonomous Capacity Planning, Performance Engineering & Predictive Scaling

CREATE TABLE IF NOT EXISTS capacity_resources_phase46 (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    environment TEXT,
    resource_type TEXT NOT NULL,
    region TEXT,
    zone TEXT,
    owner TEXT,
    criticality TEXT NOT NULL DEFAULT 'unknown',
    current_capacity REAL,
    min_capacity REAL,
    max_capacity REAL,
    scaling_capability TEXT,
    scaling_constraints TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, resource_type, region, zone)
);

CREATE TABLE IF NOT EXISTS resource_observations_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    confidence REAL,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS performance_baselines_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    baseline_value REAL,
    min_value REAL,
    max_value REAL,
    window_seconds INTEGER,
    deviation_threshold REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS utilization_analysis_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    current_utilization REAL,
    avg_utilization REAL,
    peak_utilization REAL,
    min_utilization REAL,
    variance REAL,
    trend TEXT,
    headroom REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS saturation_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    saturation_state TEXT NOT NULL DEFAULT 'unknown',
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS bottlenecks_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    bottleneck_type TEXT,
    confidence REAL,
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS demand_trends_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    trend_direction TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS capacity_forecasts_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    forecast_horizon TEXT,
    projected_utilization REAL,
    projected_capacity_requirement REAL,
    confidence REAL,
    threshold_crossing TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS capacity_risk_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'unknown',
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_opportunities_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    opportunity_type TEXT NOT NULL,
    reason TEXT,
    evidence TEXT,
    expected_impact TEXT,
    risk TEXT,
    constraints TEXT,
    proposed_action TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS optimization_plans_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    current_capacity REAL,
    proposed_capacity REAL,
    reason TEXT,
    expected_benefit TEXT,
    risk TEXT,
    estimated_impact TEXT,
    governance_requirement TEXT,
    safety_requirement TEXT,
    approval_requirement TEXT,
    rollback_plan TEXT,
    verification_criteria TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_governance_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_approvals_phase46 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    approver TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    approved_at TIMESTAMP,
    expires_at TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (plan_id) REFERENCES optimization_plans_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_safety_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    safe INTEGER NOT NULL DEFAULT 1,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_executions_phase46 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES optimization_plans_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_verifications_phase46 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES scaling_executions_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_rollbacks_phase46 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES scaling_executions_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_incidents_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_escalations_phase46 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES scaling_incidents_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_evidence_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_audit_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_lineage_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    observation_id TEXT,
    baseline_id TEXT,
    forecast_id TEXT,
    risk_id TEXT,
    opportunity_id TEXT,
    plan_id TEXT,
    execution_id TEXT,
    rollback_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_learning_phase46 (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES capacity_resources_phase46(id)
);

CREATE TABLE IF NOT EXISTS scaling_circuit_breakers_phase46 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase46_resources_provider ON capacity_resources_phase46(provider);
CREATE INDEX idx_phase46_observations_resource ON resource_observations_phase46(resource_id);
CREATE INDEX idx_phase46_plans_resource ON optimization_plans_phase46(resource_id);
CREATE INDEX idx_phase46_executions_plan ON scaling_executions_phase46(plan_id);
