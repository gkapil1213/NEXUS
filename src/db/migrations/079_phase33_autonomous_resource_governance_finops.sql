-- 079_phase33_autonomous_resource_governance_finops.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase33_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    account TEXT NOT NULL,
    environment TEXT NOT NULL,
    region TEXT NOT NULL,
    type TEXT NOT NULL,
    owner TEXT NOT NULL,
    team TEXT NOT NULL,
    application TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    tags TEXT NOT NULL,
    configuration_fingerprint TEXT NOT NULL,
    cost_metadata TEXT NOT NULL,
    security_metadata TEXT NOT NULL,
    compliance_metadata TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase33_optimization_opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    type TEXT NOT NULL,
    reason TEXT,
    estimated_savings REAL NOT NULL,
    confidence REAL NOT NULL,
    blast_radius TEXT NOT NULL,
    risk TEXT NOT NULL,
    governance_requirement TEXT NOT NULL,
    approval_required INTEGER NOT NULL,
    rollback_possible INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase33_remediation_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase33_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase33_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase33_audit (
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

CREATE TABLE IF NOT EXISTS phase33_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    resource_id TEXT NOT NULL,
    operation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase33_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    success INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
