-- Phase 76: Global Autonomous Resource Procurement, Capacity Acquisition & Provider Orchestration
-- SQLite-compatible
BEGIN;

CREATE TABLE IF NOT EXISTS resource_providers (
    id TEXT PRIMARY KEY,
    provider_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    ownership TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    trust_level TEXT NOT NULL DEFAULT 'STANDARD',
    policy TEXT,
    provisioning_capability INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_capabilities (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES resource_providers(id),
    capability TEXT NOT NULL,
    supported INTEGER NOT NULL DEFAULT 1,
    UNIQUE(provider_id, capability)
);

CREATE TABLE IF NOT EXISTS provider_regions (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES resource_providers(id),
    region_id TEXT NOT NULL,
    availability_state TEXT NOT NULL DEFAULT 'ACTIVE',
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    provider_quota_limit REAL,
    provider_quota_used REAL NOT NULL DEFAULT 0,
    UNIQUE(provider_id, region_id)
);

CREATE TABLE IF NOT EXISTS provider_resources (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES resource_providers(id),
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    total_capacity REAL NOT NULL DEFAULT 0,
    available_capacity REAL NOT NULL DEFAULT 0,
    reserved_capacity REAL NOT NULL DEFAULT 0,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_health (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES resource_providers(id),
    region_id TEXT,
    health_state TEXT NOT NULL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_policies (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES resource_providers(id),
    policy_type TEXT NOT NULL,
    policy_data TEXT,
    UNIQUE(provider_id, policy_type)
);

CREATE TABLE IF NOT EXISTS provider_failure_domains (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES resource_providers(id),
    region_id TEXT,
    availability_zone TEXT,
    resource_pool TEXT,
    fleet_id TEXT,
    UNIQUE(provider_id, region_id, availability_zone, resource_pool, fleet_id)
);

CREATE TABLE IF NOT EXISTS procurement_requirements (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    fleet_id TEXT,
    region_id TEXT,
    workload_class TEXT,
    required_capability TEXT,
    resource_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    start_time TEXT,
    expected_duration INTEGER,
    deadline TEXT,
    priority INTEGER NOT NULL DEFAULT 5,
    reason TEXT,
    urgency TEXT NOT NULL DEFAULT 'NORMAL',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procurement_plans (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES procurement_requirements(id),
    state TEXT NOT NULL DEFAULT 'DRAFT',
    provider_id TEXT,
    region_id TEXT,
    resource_type TEXT,
    quantity REAL,
    expected_cost REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procurement_candidates (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES procurement_plans(id),
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    score REAL,
    eligible INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procurement_decisions (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL,
    plan_id TEXT,
    provider_id TEXT,
    region_id TEXT,
    resource_type TEXT,
    quantity REAL,
    duration INTEGER,
    estimated_cost REAL,
    decision_state TEXT NOT NULL DEFAULT 'PROPOSED',
    decision_epoch INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procurement_reservations (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    scope TEXT NOT NULL, -- budget, quota, provider, capacity
    entity_id TEXT NOT NULL,
    amount REAL NOT NULL,
    expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'ACQUIRED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(decision_id, scope, entity_id)
);

CREATE TABLE IF NOT EXISTS acquisition_operations (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    provider_id TEXT,
    region_id TEXT,
    resource_type TEXT,
    quantity REAL,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    started_at TEXT,
    completed_at TEXT,
    failure_reason TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provisioning_operations (
    id TEXT PRIMARY KEY,
    acquisition_id TEXT NOT NULL REFERENCES acquisition_operations(id),
    state TEXT NOT NULL DEFAULT 'PENDING',
    provider_resource_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provisioned_resources (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capacity_registrations (
    id TEXT PRIMARY KEY,
    provisioned_resource_id TEXT NOT NULL REFERENCES provisioned_resources(id),
    fleet_id TEXT,
    region_id TEXT,
    resource_type TEXT,
    quantity REAL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capacity_release_operations (
    id TEXT PRIMARY KEY,
    provisioned_resource_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capacity_scaling_operations (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('UP','DOWN')),
    quantity REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS burst_capacity (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    start_time TEXT NOT NULL DEFAULT (datetime('now')),
    expiry_time TEXT NOT NULL,
    owner TEXT NOT NULL,
    max_cost REAL,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reserved_capacity (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    start_time TEXT NOT NULL DEFAULT (datetime('now')),
    end_time TEXT,
    budget_id TEXT,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emergency_capacity (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    incident_id TEXT,
    authorized_by TEXT,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('provider','procurement','global','project','environment')),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS procurement_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    affected_provider_id TEXT,
    affected_project_id TEXT,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS procurement_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procurement_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    provider_id TEXT,
    project_id TEXT,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procurement_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procurement_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_provider_cap_provider ON provider_capabilities(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_regions_provider ON provider_regions(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_resources_provider ON provider_resources(provider_id);
CREATE INDEX IF NOT EXISTS idx_procurement_requirements_project ON procurement_requirements(project_id);
CREATE INDEX IF NOT EXISTS idx_procurement_plans_req ON procurement_plans(requirement_id);
CREATE INDEX IF NOT EXISTS idx_acquisition_decision ON acquisition_operations(decision_id);
CREATE INDEX IF NOT EXISTS idx_provisioning_acq ON provisioning_operations(acquisition_id);
CREATE INDEX IF NOT EXISTS idx_capacity_reg_prov ON capacity_registrations(provisioned_resource_id);
CREATE INDEX IF NOT EXISTS idx_provider_cb_scope ON provider_circuit_breakers(scope, entity_id);

COMMIT;