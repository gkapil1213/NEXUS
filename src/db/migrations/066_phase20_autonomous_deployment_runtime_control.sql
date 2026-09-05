-- 066_phase20_autonomous_deployment_runtime_control.sql

BEGIN;

CREATE TABLE IF NOT EXISTS deployment_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    region TEXT,
    endpoint TEXT,
    capabilities TEXT NOT NULL,
    status TEXT NOT NULL,
    authentication_ref TEXT,
    configuration_fingerprint TEXT NOT NULL,
    health_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS deployment_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    release_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    strategy TEXT NOT NULL,
    rollout_config TEXT NOT NULL,
    health_gates TEXT NOT NULL,
    rollback_policy TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    approval_required INTEGER NOT NULL,
    risk_level TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deployment_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deployment_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lock_id TEXT NOT NULL UNIQUE,
    environment TEXT NOT NULL,
    target_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released INTEGER NOT NULL DEFAULT 0,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS deployment_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS deployment_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    release_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deployment_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    deployment_id TEXT,
    release_id TEXT,
    artifact_id TEXT,
    target_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

COMMIT;
