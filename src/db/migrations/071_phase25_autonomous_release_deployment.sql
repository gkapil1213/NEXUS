-- 071_phase25_autonomous_release_deployment.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase25_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    artifact_id TEXT,
    source_commit TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_release_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id TEXT NOT NULL,
    version TEXT NOT NULL,
    prev_version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_artifact_promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL,
    state TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_deployment_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    release_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    target TEXT NOT NULL,
    environment TEXT NOT NULL,
    strategy TEXT NOT NULL,
    rollout_config TEXT NOT NULL,
    health_requirements TEXT NOT NULL,
    rollback_policy TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    approval_required INTEGER NOT NULL,
    risk_level TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_deployment_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_deployment_rollbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollback_id TEXT NOT NULL UNIQUE,
    deployment_id TEXT NOT NULL,
    target_release_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_release_freezes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    freeze_id TEXT NOT NULL UNIQUE,
    environment TEXT NOT NULL,
    reason TEXT NOT NULL,
    frozen INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_deployment_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    deployment_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    target TEXT NOT NULL,
    failure_reason TEXT NOT NULL,
    health_evidence TEXT NOT NULL,
    rollback_state TEXT NOT NULL,
    recovery_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_deployment_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    deployment_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    strategy TEXT NOT NULL,
    health_result TEXT NOT NULL,
    rollback_state TEXT NOT NULL,
    final_result TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase25_deployment_audit (
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

CREATE TABLE IF NOT EXISTS phase25_release_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    artifact_id TEXT,
    deployment_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
