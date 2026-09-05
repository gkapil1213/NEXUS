-- 064_phase18_production_autonomous_operations.sql

BEGIN;

CREATE TABLE IF NOT EXISTS production_environments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    environment_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    provider TEXT NOT NULL,
    region TEXT,
    cluster TEXT,
    account TEXT,
    configuration_fingerprint TEXT NOT NULL,
    health TEXT NOT NULL,
    availability INTEGER NOT NULL,
    capabilities TEXT NOT NULL,
    last_verified_at TEXT NOT NULL,
    owner TEXT NOT NULL,
    policy TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id TEXT NOT NULL UNIQUE,
    artifact_id TEXT NOT NULL,
    version TEXT NOT NULL,
    source_commit TEXT NOT NULL,
    build_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    status TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_deployment_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    release_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    execution_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    environment_id TEXT NOT NULL,
    release_id TEXT,
    service TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_remediations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remediation_id TEXT NOT NULL UNIQUE,
    incident_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    target TEXT NOT NULL,
    governance_approved INTEGER NOT NULL,
    safety_approved INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_drift_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desired_fingerprint TEXT NOT NULL,
    actual_fingerprint TEXT NOT NULL,
    drift_detected INTEGER NOT NULL,
    affected_resource TEXT NOT NULL,
    severity TEXT NOT NULL,
    source TEXT NOT NULL,
    remediated INTEGER NOT NULL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS production_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    environment_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    release_id TEXT,
    execution_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

COMMIT;
