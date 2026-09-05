-- 065_phase19_autonomous_cicd_release_engineering.sql

BEGIN;

CREATE TABLE IF NOT EXISTS pipeline_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    stages TEXT NOT NULL,
    required_stages TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    retry_policy TEXT NOT NULL,
    approval_required INTEGER NOT NULL,
    artifact_required INTEGER NOT NULL,
    security_required INTEGER NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    policy TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS pipeline_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    pipeline_id TEXT NOT NULL,
    pipeline_version INTEGER NOT NULL,
    repository TEXT NOT NULL,
    revision TEXT NOT NULL,
    status TEXT NOT NULL,
    actor TEXT NOT NULL,
    trigger TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stage_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_execution_id TEXT NOT NULL UNIQUE,
    execution_id TEXT NOT NULL,
    stage_name TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    executor TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    output_fingerprint TEXT,
    logs_reference TEXT,
    artifact_references TEXT NOT NULL,
    failure_reason TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL UNIQUE,
    pipeline_execution_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    build_fingerprint TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS release_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_candidate_id TEXT NOT NULL UNIQUE,
    artifact_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    pipeline_execution_id TEXT NOT NULL,
    version TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    approval_state TEXT NOT NULL,
    safety_state TEXT NOT NULL,
    governance_state TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

COMMIT;
