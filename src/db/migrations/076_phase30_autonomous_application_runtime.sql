-- 076_phase30_autonomous_application_runtime.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase30_application_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL UNIQUE,
    application_name TEXT NOT NULL,
    service_name TEXT NOT NULL,
    environment TEXT NOT NULL,
    version TEXT NOT NULL,
    runtime_type TEXT NOT NULL,
    deployment_ref TEXT NOT NULL,
    owner TEXT NOT NULL,
    criticality TEXT NOT NULL,
    protection_level TEXT NOT NULL,
    provider TEXT NOT NULL,
    region TEXT NOT NULL,
    health_state TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    metadata TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase30_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    environment TEXT NOT NULL,
    version TEXT NOT NULL,
    owner TEXT NOT NULL,
    criticality TEXT NOT NULL,
    protected INTEGER NOT NULL,
    health_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase30_runtime_anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anomaly_id TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase30_remediation_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL,
    actions TEXT NOT NULL,
    reason TEXT,
    risk TEXT NOT NULL,
    blast_radius TEXT NOT NULL,
    governance_requirement TEXT NOT NULL,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase30_remediation_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase30_runtime_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase30_runtime_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase30_runtime_audit (
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

CREATE TABLE IF NOT EXISTS phase30_runtime_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    service_id TEXT NOT NULL,
    operation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase30_runtime_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition TEXT NOT NULL,
    remediation TEXT NOT NULL,
    success INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
