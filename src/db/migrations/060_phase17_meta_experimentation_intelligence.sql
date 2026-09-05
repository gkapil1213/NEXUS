-- 060_phase17_meta_experimentation_intelligence.sql

BEGIN;

CREATE TABLE IF NOT EXISTS experimental_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    parent_lineage_id TEXT,
    tenant_id TEXT NOT NULL,
    objectives TEXT NOT NULL,
    constraints TEXT NOT NULL,
    expected_cost REAL NOT NULL,
    expected_benefit REAL NOT NULL,
    historical_performance REAL NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    governance_state TEXT NOT NULL,
    safety_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS meta_experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meta_experiment_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    objective_id TEXT NOT NULL,
    method_ids TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    constraints TEXT NOT NULL,
    budget REAL NOT NULL,
    minimum_evidence INTEGER NOT NULL,
    confidence_threshold REAL NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS meta_experiment_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    meta_experiment_id TEXT NOT NULL,
    method_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence_type TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    durability REAL NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS meta_experiment_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    method_id TEXT NOT NULL,
    meta_experiment_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    evidence TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS meta_experiment_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    meta_experiment_id TEXT NOT NULL,
    method_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

COMMIT;
