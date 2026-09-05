-- 062_phase17_optimization_portfolio_execution_closed_loop.sql

BEGIN;

CREATE TABLE IF NOT EXISTS portfolio_execution_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    portfolio_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    steps TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS portfolio_execution_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    portfolio_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_execution_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id TEXT NOT NULL,
    total_budget REAL NOT NULL,
    reserved REAL NOT NULL,
    consumed REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_execution_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outcome_id TEXT NOT NULL UNIQUE,
    execution_id TEXT NOT NULL,
    portfolio_id TEXT NOT NULL,
    portfolio_version INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_generation_id TEXT NOT NULL,
    experiment_id TEXT,
    meta_experiment_id TEXT,
    decision_id TEXT,
    resource_used REAL NOT NULL,
    result TEXT NOT NULL,
    evidence TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS portfolio_execution_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    portfolio_version INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_generation_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    experiment_id TEXT,
    meta_experiment_id TEXT,
    plan_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    outcome_id TEXT,
    adaptation_id TEXT,
    reason TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_execution_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    portfolio_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    evidence TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS portfolio_execution_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    portfolio_id TEXT NOT NULL,
    execution_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

COMMIT;
