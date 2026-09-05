-- 072_phase26_autonomous_production_operations.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase26_telemetry_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telemetry_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    source_type TEXT NOT NULL,
    service TEXT NOT NULL,
    environment TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    severity TEXT NOT NULL,
    dimensions TEXT NOT NULL,
    metadata TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    provenance TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase26_anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anomaly_id TEXT NOT NULL UNIQUE,
    telemetry_id TEXT NOT NULL,
    detector TEXT NOT NULL,
    severity TEXT NOT NULL,
    score REAL NOT NULL,
    explanation TEXT,
    detected_at TEXT NOT NULL,
    confidence REAL NOT NULL,
    provenance TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase26_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    service TEXT NOT NULL,
    environment TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    fingerprint TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase26_remediation_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    incident_id TEXT NOT NULL,
    actions TEXT NOT NULL,
    expected_outcome TEXT,
    risk TEXT NOT NULL,
    prerequisites TEXT NOT NULL,
    safety_checks TEXT NOT NULL,
    rollback_plan TEXT,
    verification_plan TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase26_remediation_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase26_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    operation TEXT NOT NULL,
    actor TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    inputs TEXT NOT NULL,
    decision TEXT NOT NULL,
    execution_result TEXT NOT NULL,
    verification_result TEXT NOT NULL,
    provenance TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase26_audit_events (
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

CREATE TABLE IF NOT EXISTS phase26_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    incident_id TEXT NOT NULL,
    remediation_id TEXT,
    evidence_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase26_learning_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_type TEXT NOT NULL,
    remediation_type TEXT NOT NULL,
    predicted_risk TEXT NOT NULL,
    actual_risk TEXT NOT NULL,
    predicted_outcome TEXT NOT NULL,
    actual_outcome TEXT NOT NULL,
    verification TEXT NOT NULL,
    rollback TEXT NOT NULL,
    duration INTEGER NOT NULL,
    recurrence INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
