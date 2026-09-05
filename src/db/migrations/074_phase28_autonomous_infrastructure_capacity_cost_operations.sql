-- 074_phase28_autonomous_infrastructure_capacity_cost_operations.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase28_infrastructure_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    account TEXT NOT NULL,
    region TEXT NOT NULL,
    environment TEXT NOT NULL,
    type TEXT NOT NULL,
    resource_name TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    health TEXT NOT NULL,
    owner TEXT NOT NULL,
    tags TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    criticality TEXT NOT NULL,
    workload TEXT NOT NULL,
    security_classification TEXT NOT NULL,
    cost_center TEXT NOT NULL,
    current_capacity REAL NOT NULL,
    allocated_capacity REAL NOT NULL,
    utilized_capacity REAL NOT NULL,
    desired_capacity REAL NOT NULL,
    min_capacity REAL NOT NULL,
    max_capacity REAL NOT NULL,
    last_observation TEXT NOT NULL,
    metadata TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase28_optimization_opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    type TEXT NOT NULL,
    rationale TEXT,
    evidence TEXT NOT NULL,
    estimated_impact TEXT,
    risk TEXT NOT NULL,
    confidence REAL NOT NULL,
    blast_radius TEXT NOT NULL,
    recommended_action TEXT NOT NULL,
    rollback_plan TEXT,
    governance_state TEXT NOT NULL,
    execution_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase28_optimization_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    opportunity_id TEXT NOT NULL,
    actions TEXT NOT NULL,
    estimated_cost_saving REAL NOT NULL,
    risk TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase28_infrastructure_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase28_infrastructure_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase28_infrastructure_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase28_infrastructure_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

CREATE TABLE IF NOT EXISTS phase28_infrastructure_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    resource_id TEXT NOT NULL,
    opportunity_id TEXT,
    execution_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase28_infrastructure_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_type TEXT NOT NULL,
    success INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
