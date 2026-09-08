-- Phase 87: Autonomous Engineering Organization Control Plane
BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE',
    risk_classification TEXT,
    governance_profile TEXT,
    safety_profile TEXT,
    financial_envelope REAL,
    resource_envelope REAL,
    execution_policy TEXT,
    autonomy_level TEXT NOT NULL DEFAULT 'RECOMMEND',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engineering_business_units (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    owner TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(organization_id, name)
);

CREATE TABLE IF NOT EXISTS engineering_teams (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    business_unit_id TEXT REFERENCES engineering_business_units(id),
    name TEXT NOT NULL,
    capacity REAL,
    capabilities TEXT,
    concurrency INT,
    risk_permissions TEXT,
    environment_permissions TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategic_objectives (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    business_value REAL,
    deadline TEXT,
    risk_tolerance TEXT,
    budget_envelope REAL,
    resource_envelope REAL,
    success_criteria TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS objective_relationships (
    id TEXT PRIMARY KEY,
    parent_objective_id TEXT,
    child_objective_id TEXT,
    relationship_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engineering_portfolios (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    owner TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engineering_programs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    portfolio_id TEXT REFERENCES engineering_portfolios(id),
    name TEXT NOT NULL,
    owner TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_dependencies (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    source_type TEXT,
    source_id TEXT,
    target_type TEXT,
    target_id TEXT,
    UNIQUE(organization_id, source_type, source_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS strategic_conflicts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    conflict_type TEXT,
    entity_a TEXT,
    entity_b TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_resource_envelopes (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    resource_type TEXT NOT NULL,
    total REAL NOT NULL,
    allocated REAL NOT NULL DEFAULT 0,
    reserved REAL NOT NULL DEFAULT 0,
    available REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(organization_id, resource_type)
);

CREATE TABLE IF NOT EXISTS organization_budget_envelopes (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    limit_amount REAL NOT NULL,
    committed REAL NOT NULL DEFAULT 0,
    reserved REAL NOT NULL DEFAULT 0,
    consumed REAL NOT NULL DEFAULT 0,
    remaining REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(organization_id)
);

CREATE TABLE IF NOT EXISTS organization_quota_policies (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    quota_type TEXT NOT NULL,
    hard_limit REAL,
    soft_limit REAL,
    burst_allowance REAL,
    protected_capacity REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_capacity_snapshots (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    resource_type TEXT NOT NULL,
    observed_capacity REAL,
    forecast_capacity REAL,
    committed_capacity REAL,
    reserved_capacity REAL,
    active_capacity REAL,
    expected_demand REAL,
    capacity_gap REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_resource_allocations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    resource_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    amount REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'ALLOCATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_resource_reservations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    resource_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    amount REAL NOT NULL,
    expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'RESERVED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategic_priority_decisions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    entity_type TEXT,
    entity_id TEXT,
    priority_score REAL,
    rationale TEXT,
    confidence REAL,
    decision_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_arbitration_decisions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    resource_type TEXT,
    winner_entity_type TEXT,
    winner_entity_id TEXT,
    loser_entity_type TEXT,
    loser_entity_id TEXT,
    rationale TEXT,
    opportunity_cost REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_risk_assessments (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    risk_type TEXT,
    severity TEXT,
    confidence REAL,
    blast_radius REAL,
    affected_domains TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_resilience_assessments (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    resilience_score REAL,
    gaps TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_scenarios (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    scenario_type TEXT,
    state TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_scenario_results (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES organization_scenarios(id),
    result_type TEXT,
    value REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_windows (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    window_type TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS protected_periods (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_freezes (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    scope TEXT NOT NULL,
    entity_id TEXT,
    freeze_state TEXT NOT NULL DEFAULT 'FROZEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_circuit_breakers (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(organization_id, scope, entity_id)
);

CREATE TABLE IF NOT EXISTS portfolio_circuit_breakers (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS organizational_decisions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    decision_type TEXT NOT NULL,
    context TEXT,
    selected_option TEXT,
    rejected_options TEXT,
    rationale TEXT,
    confidence REAL,
    governance_result TEXT,
    safety_result TEXT,
    approval_state TEXT DEFAULT 'NONE',
    decision_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_execution_plans (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    state TEXT NOT NULL DEFAULT 'DRAFT',
    plan_content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_execution_steps (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES organizational_execution_plans(id),
    entity_type TEXT,
    entity_id TEXT,
    order_index INTEGER,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_incidents (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    incident_type TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS organizational_escalations (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    reason TEXT,
    level TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_evidence (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    entity_type TEXT,
    entity_id TEXT,
    evidence_type TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_audit (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    event_type TEXT,
    entity_type TEXT,
    entity_id TEXT,
    actor TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_lineage (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    entity_type TEXT,
    entity_id TEXT,
    phase TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_learning (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    learning_type TEXT,
    entity_id TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_org_objectives_org ON strategic_objectives(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_portfolios_org ON engineering_portfolios(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_programs_org ON engineering_programs(organization_id);

COMMIT;