-- 061_phase17_optimization_portfolio_intelligence.sql

BEGIN;

CREATE TABLE IF NOT EXISTS optimization_portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    owner_context TEXT NOT NULL,
    included_populations TEXT NOT NULL,   -- JSON
    resource_budget REAL NOT NULL,
    risk_budget REAL NOT NULL,
    experiment_limits INTEGER NOT NULL,
    governance_policy TEXT NOT NULL,
    safety_policy TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS optimization_portfolio_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL UNIQUE,
    portfolio_id TEXT NOT NULL,
    source_populations TEXT NOT NULL,     -- JSON
    action TEXT NOT NULL,
    reason TEXT,
    evidence TEXT NOT NULL,               -- JSON
    confidence REAL NOT NULL,
    impact_estimate REAL NOT NULL,
    risk_estimate REAL NOT NULL,
    recommended_action TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS optimization_portfolio_experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL UNIQUE,
    portfolio_id TEXT NOT NULL,
    population_ids TEXT NOT NULL,         -- JSON
    action TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    objective TEXT NOT NULL,
    metrics TEXT NOT NULL,                -- JSON
    constraints TEXT NOT NULL,            -- JSON
    budget REAL NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS optimization_portfolio_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    portfolio_id TEXT NOT NULL,
    source_population_id TEXT NOT NULL,
    target_population_id TEXT NOT NULL,
    outcome TEXT NOT NULL,                -- JSON
    confidence REAL NOT NULL,
    evidence_type TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    durability REAL NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS optimization_portfolio_learning_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    portfolio_id TEXT NOT NULL,
    source_population_id TEXT NOT NULL,
    target_population_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    transferred_knowledge TEXT NOT NULL,
    evidence TEXT NOT NULL,               -- JSON
    confidence REAL NOT NULL,
    decision TEXT NOT NULL,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS optimization_portfolio_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    previous_version INTEGER,
    reason TEXT,
    action TEXT,
    population_id TEXT,
    experiment_id TEXT,
    learning_record_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL,
    UNIQUE(portfolio_id, version)
);

CREATE TABLE IF NOT EXISTS optimization_portfolio_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    portfolio_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

COMMIT;
