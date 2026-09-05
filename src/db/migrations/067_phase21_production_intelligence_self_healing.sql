-- 067_phase21_production_intelligence_self_healing.sql

BEGIN;

CREATE TABLE IF NOT EXISTS production_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    metric TEXT NOT NULL,
    severity TEXT NOT NULL,
    observed_value REAL NOT NULL,
    expected_value REAL,
    correlation_id TEXT,
    deployment_context TEXT,
    release_context TEXT,
    metadata TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL,
    anomaly_status TEXT NOT NULL,
    thresholds TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_hypotheses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hypothesis_id TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    confidence REAL NOT NULL,
    supporting_signals TEXT NOT NULL,
    contradicting_signals TEXT NOT NULL,
    explanation TEXT,
    recommended_action TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_remediation_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    incident_id TEXT NOT NULL,
    hypothesis_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target TEXT NOT NULL,
    parameters TEXT NOT NULL,
    expected_outcome TEXT,
    risk_level TEXT NOT NULL,
    rollback_capability INTEGER NOT NULL,
    verification_strategy TEXT,
    authorization_required INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_remediation_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS production_remediation_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    verification_status TEXT NOT NULL,
    before_state TEXT NOT NULL,
    after_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_learning_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    hypothesis_id TEXT NOT NULL,
    remediation_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    failure_classification TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS production_intelligence_audit (
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
