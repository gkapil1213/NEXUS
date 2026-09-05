-- 055_phase17_strategy_execution_closed_loop.sql
BEGIN;

CREATE TABLE IF NOT EXISTS strategy_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    environment TEXT NOT NULL,
    status TEXT NOT NULL,
    current_step_id TEXT,
    started_at TEXT,
    ended_at TEXT,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_execution_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step_id TEXT NOT NULL UNIQUE,
    strategy_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    action TEXT NOT NULL,
    parameters TEXT NOT NULL,
    expected_effect TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    retry_policy TEXT NOT NULL,
    verification_requirement TEXT NOT NULL,
    rollback_requirement TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    decision TEXT,
    reason TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

CREATE TABLE IF NOT EXISTS strategy_execution_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    expected_metrics TEXT NOT NULL,
    observed_metrics TEXT NOT NULL,
    confidence TEXT NOT NULL,
    evaluation_window_days INTEGER NOT NULL,
    sample_size INTEGER NOT NULL,
    statistical_sufficiency INTEGER NOT NULL,
    causality_confidence REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_execution_drift (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    drift_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    baseline TEXT NOT NULL,
    observed TEXT NOT NULL,
    evidence TEXT,
    recommended_action TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_execution_adaptations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    parent_strategy_id TEXT NOT NULL,
    previous_version TEXT NOT NULL,
    new_version TEXT NOT NULL,
    adaptation_reason TEXT NOT NULL,
    evidence TEXT,
    outcome TEXT,
    confidence TEXT,
    governance_decision TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_execution_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    evidence TEXT,
    failure_reason TEXT,
    successful_conditions TEXT,
    environmental_conditions TEXT,
    adaptations TEXT,
    rollback_info TEXT,
    confidence TEXT,
    recurrence INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS strategy_execution_rollbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    rollback_target TEXT NOT NULL,
    status TEXT NOT NULL,
    verification_succeeded INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS strategy_confidence_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    previous_confidence TEXT,
    new_confidence TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;