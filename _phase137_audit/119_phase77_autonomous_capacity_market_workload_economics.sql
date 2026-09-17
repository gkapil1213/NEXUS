-- Phase 77: Autonomous Engineering Capacity Market, Workload Economics & Global Resource Optimization
-- SQLite-compatible
BEGIN;

CREATE TABLE IF NOT EXISTS capacity_market_offers (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    capacity_amount REAL NOT NULL,
    available_start TEXT,
    available_end TEXT,
    reservation_characteristics TEXT,
    reliability_characteristics TEXT,
    cost_model TEXT,
    pricing_model TEXT,
    commitment_requirements TEXT,
    cancellation_constraints TEXT,
    utilization_restrictions TEXT,
    environment_restrictions TEXT,
    project_restrictions TEXT,
    governance_restrictions TEXT,
    state TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider_id, region_id, resource_type, capacity_amount, available_start)
);

CREATE TABLE IF NOT EXISTS capacity_market_requests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    workload_id TEXT,
    resource_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    duration INTEGER,
    deadline TEXT,
    priority INTEGER NOT NULL DEFAULT 5,
    risk TEXT,
    required_reliability TEXT,
    required_region TEXT,
    allowed_providers TEXT,
    maximum_budget REAL,
    governance_policy TEXT,
    approval_requirements TEXT,
    optimization_objective TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capacity_market_quotes (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES capacity_market_requests(id),
    offer_id TEXT NOT NULL REFERENCES capacity_market_offers(id),
    price REAL,
    currency TEXT,
    validity_start TEXT,
    validity_end TEXT,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capacity_market_allocations (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'ALLOCATED',
    allocated_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT,
    correlation_id TEXT NOT NULL,
    UNIQUE(request_id, offer_id)
);

CREATE TABLE IF NOT EXISTS resource_price_observations (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    observed_price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    unit TEXT,
    observation_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    validity_start TEXT,
    validity_end TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workload_economic_profiles (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    expected_resource_consumption TEXT,
    expected_duration INTEGER,
    expected_cost REAL,
    maximum_acceptable_cost REAL,
    budget_class TEXT,
    cost_sensitivity TEXT,
    deadline_sensitivity TEXT,
    reliability_sensitivity TEXT,
    performance_sensitivity TEXT,
    carbon_efficiency_preference TEXT,
    interruption_tolerance INTEGER NOT NULL DEFAULT 0,
    preemption_tolerance INTEGER NOT NULL DEFAULT 0,
    reservation_preference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workload_cost_estimates (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    provider_id TEXT,
    region_id TEXT,
    resource_type TEXT,
    estimated_cost REAL,
    currency TEXT,
    cost_model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capacity_cost_models (
    id TEXT PRIMARY KEY,
    provider_id TEXT,
    region_id TEXT,
    resource_type TEXT,
    fixed_cost REAL,
    usage_cost REAL,
    time_based_cost REAL,
    reservation_cost REAL,
    burst_cost REAL,
    emergency_cost REAL,
    acquisition_cost REAL,
    release_cost REAL,
    recovery_cost REAL,
    rollback_cost REAL,
    failure_cost REAL,
    provider_switching_cost REAL,
    opportunity_cost REAL,
    assumptions TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_cost_profiles (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES resource_providers(id),
    base_price REAL,
    reservation_price REAL,
    burst_price REAL,
    emergency_price REAL,
    acquisition_cost REAL,
    release_cost REAL,
    reliability_rating REAL,
    failure_history TEXT,
    capacity_availability TEXT,
    region_availability TEXT,
    quota TEXT,
    budget_compatibility TEXT,
    switching_cost REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_price_history (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS optimization_decisions_phase77 (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    workload_id TEXT,
    objective TEXT,
    constraints TEXT,
    candidates TEXT,
    rejected_candidates TEXT,
    selected_candidate TEXT,
    score REAL,
    reason TEXT,
    decision_state TEXT NOT NULL DEFAULT 'PROPOSED',
    decision_epoch INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS economic_reservations (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    offer_id TEXT,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    amount REAL NOT NULL,
    expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'ACQUIRED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(request_id, scope, entity_id)
);

CREATE TABLE IF NOT EXISTS capacity_exchange_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    request_id TEXT,
    offer_id TEXT,
    allocation_id TEXT,
    details TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workload_cost_attributions (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    amount REAL NOT NULL,
    attribution_method TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_resource_budgets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    limit_amount REAL NOT NULL,
    consumed_amount REAL NOT NULL DEFAULT 0,
    reserved_amount REAL NOT NULL DEFAULT 0,
    period TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, resource_type, period)
);

CREATE TABLE IF NOT EXISTS project_cost_usage (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    amount REAL NOT NULL,
    usage_type TEXT NOT NULL CHECK (usage_type IN ('ACTUAL','RESERVED','PROJECTED')),
    period TEXT,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_cost_usage (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    amount REAL NOT NULL,
    usage_type TEXT NOT NULL CHECK (usage_type IN ('ACTUAL','RESERVED','PROJECTED')),
    period TEXT,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environment_cost_usage (
    id TEXT PRIMARY KEY,
    environment TEXT NOT NULL,
    amount REAL NOT NULL,
    usage_type TEXT NOT NULL CHECK (usage_type IN ('ACTUAL','RESERVED','PROJECTED')),
    period TEXT,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS economic_alerts (
    id TEXT PRIMARY KEY,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    entity_id TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS optimization_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    affected_entity_id TEXT,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS economic_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS economic_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    region_id TEXT,
    project_id TEXT,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS economic_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS economic_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_capacity_market_offers_provider ON capacity_market_offers(provider_id);
CREATE INDEX IF NOT EXISTS idx_capacity_market_requests_project ON capacity_market_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_price_obs_provider ON resource_price_observations(provider_id, region_id, resource_type);
CREATE INDEX IF NOT EXISTS idx_workload_econ_profile_wid ON workload_economic_profiles(workload_id);
CREATE INDEX IF NOT EXISTS idx_opt_decisions_request ON optimization_decisions_phase77(request_id);
CREATE INDEX IF NOT EXISTS idx_economic_alerts_type ON economic_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_optimization_incidents_type ON optimization_incidents(incident_type);


CREATE TABLE IF NOT EXISTS economic_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('market','provider','budget','cost_anomaly','capacity_protection','global','project','environment')),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);
COMMIT;
