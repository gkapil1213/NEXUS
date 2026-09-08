-- Phase 75: Global Autonomous Resource Economics, Budget & Quota Governance
-- SQLite-compatible
BEGIN;

CREATE TABLE IF NOT EXISTS resource_usage_records (
    id TEXT PRIMARY KEY,
    region_id TEXT,
    fleet_id TEXT,
    project_id TEXT,
    environment TEXT,
    resource_type TEXT NOT NULL,
    requested REAL NOT NULL DEFAULT 0,
    allocated REAL NOT NULL DEFAULT 0,
    reserved REAL NOT NULL DEFAULT 0,
    active REAL NOT NULL DEFAULT 0,
    consumed REAL NOT NULL DEFAULT 0,
    released REAL NOT NULL DEFAULT 0,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    UNIQUE(region_id, fleet_id, project_id, environment, resource_type, observed_at)
);

CREATE TABLE IF NOT EXISTS cost_sources (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    freshness TEXT NOT NULL DEFAULT 'CURRENT',
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider)
);

CREATE TABLE IF NOT EXISTS cost_records (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES cost_sources(id),
    region_id TEXT,
    fleet_id TEXT,
    project_id TEXT,
    environment TEXT,
    workload_id TEXT,
    resource_type TEXT,
    quantity REAL,
    unit_cost REAL,
    total_cost REAL,
    currency TEXT,
    period TEXT,
    cost_type TEXT NOT NULL DEFAULT 'ACTUAL' CHECK (cost_type IN ('ACTUAL','ESTIMATED','UNAVAILABLE')),
    freshness TEXT NOT NULL DEFAULT 'CURRENT',
    confidence REAL NOT NULL DEFAULT 1.0,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_attributions (
    id TEXT PRIMARY KEY,
    cost_record_id TEXT NOT NULL REFERENCES cost_records(id),
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    proportion REAL NOT NULL DEFAULT 1.0,
    attribution_method TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cost_forecasts (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    environment TEXT,
    provider TEXT,
    region_id TEXT,
    period TEXT,
    projected_cost REAL,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_definitions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    scope TEXT NOT NULL,
    project_id TEXT,
    environment TEXT,
    fleet_id TEXT,
    region_id TEXT,
    provider TEXT,
    period TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    limit_amount REAL NOT NULL,
    consumed_amount REAL NOT NULL DEFAULT 0,
    reserved_amount REAL NOT NULL DEFAULT 0,
    projected_amount REAL NOT NULL DEFAULT 0,
    threshold_warning REAL,
    threshold_critical REAL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    policy TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budget_usage (
    id TEXT PRIMARY KEY,
    budget_id TEXT NOT NULL REFERENCES budget_definitions(id),
    amount REAL NOT NULL,
    usage_type TEXT NOT NULL CHECK (usage_type IN ('ACTUAL','RESERVED','PROJECTED')),
    period TEXT,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_definitions (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    quota_type TEXT NOT NULL,
    limit_amount REAL NOT NULL,
    used_amount REAL NOT NULL DEFAULT 0,
    reserved_amount REAL NOT NULL DEFAULT 0,
    parent_quota_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope, entity_id, quota_type)
);

CREATE TABLE IF NOT EXISTS quota_usage (
    id TEXT PRIMARY KEY,
    quota_id TEXT NOT NULL REFERENCES quota_definitions(id),
    amount REAL NOT NULL,
    usage_type TEXT NOT NULL CHECK (usage_type IN ('USED','RESERVED')),
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_reservations (
    id TEXT PRIMARY KEY,
    quota_id TEXT NOT NULL REFERENCES quota_definitions(id),
    workload_id TEXT NOT NULL,
    amount REAL NOT NULL,
    expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'ACQUIRED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(quota_id, workload_id)
);

CREATE TABLE IF NOT EXISTS quota_change_requests (
    id TEXT PRIMARY KEY,
    quota_id TEXT NOT NULL REFERENCES quota_definitions(id),
    requested_limit REAL NOT NULL,
    reason TEXT,
    approval_state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved_by TEXT,
    approved_at TEXT
);

CREATE TABLE IF NOT EXISTS economic_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('global','provider','region','fleet','project','environment')),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS economic_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    affected_region_id TEXT,
    affected_project_id TEXT,
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

CREATE INDEX IF NOT EXISTS idx_cost_records_source ON cost_records(source_id);
CREATE INDEX IF NOT EXISTS idx_budget_project ON budget_definitions(project_id);
CREATE INDEX IF NOT EXISTS idx_quota_scope ON quota_definitions(scope, entity_id);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_quota ON quota_reservations(quota_id);
CREATE INDEX IF NOT EXISTS idx_economic_cb_scope ON economic_circuit_breakers(scope, entity_id);

COMMIT;