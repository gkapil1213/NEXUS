-- 075_phase29_autonomous_data_operations.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase29_database_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    engine TEXT NOT NULL,
    environment TEXT NOT NULL,
    region TEXT NOT NULL,
    version TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    availability REAL NOT NULL,
    capacity REAL NOT NULL,
    storage REAL NOT NULL,
    connections INTEGER NOT NULL,
    replication INTEGER NOT NULL,
    health TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    protected INTEGER NOT NULL,
    ownership TEXT NOT NULL,
    metadata TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase29_migration_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    migration_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    source_schema TEXT NOT NULL,
    target_schema TEXT NOT NULL,
    operations TEXT NOT NULL,
    preconditions TEXT NOT NULL,
    safety_classification TEXT NOT NULL,
    governance_requirements TEXT NOT NULL,
    rollback_plan TEXT NOT NULL,
    verification_plan TEXT NOT NULL,
    risk TEXT NOT NULL,
    impact TEXT NOT NULL,
    blast_radius TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase29_migration_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    migration_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase29_data_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    resource_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase29_data_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase29_data_audit (
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

CREATE TABLE IF NOT EXISTS phase29_data_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    resource_id TEXT NOT NULL,
    operation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase29_data_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_type TEXT NOT NULL,
    success INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
