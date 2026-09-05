-- 052_phase17_optimization_portfolio_cross_experiment_learning.sql

BEGIN;

-- Optimization portfolios
CREATE TABLE IF NOT EXISTS optimization_portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    objective_set TEXT NOT NULL,           -- JSON array
    candidates TEXT NOT NULL,              -- JSON array
    experiments TEXT NOT NULL,             -- JSON array
    policy_versions TEXT NOT NULL,         -- JSON array
    state TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    risk TEXT NOT NULL,
    expected_benefit REAL NOT NULL DEFAULT 0,
    confidence TEXT NOT NULL,
    resource_requirements TEXT NOT NULL,   -- JSON
    dependencies TEXT NOT NULL,            -- JSON
    conflicts TEXT NOT NULL,               -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Optimization candidates
CREATE TABLE IF NOT EXISTS optimization_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_version TEXT NOT NULL,
    objective_impact TEXT NOT NULL,        -- JSON
    expected_benefit REAL NOT NULL,
    confidence TEXT NOT NULL,
    risk TEXT NOT NULL,
    required_evidence TEXT NOT NULL,       -- JSON
    dependencies TEXT NOT NULL,            -- JSON
    conflicts TEXT NOT NULL,               -- JSON
    rollback_plan TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Candidate interactions
CREATE TABLE IF NOT EXISTS optimization_candidate_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    candidate_a TEXT NOT NULL,
    candidate_b TEXT NOT NULL,
    interaction_result TEXT NOT NULL,      -- POSITIVE_SYNERGY, NEUTRAL, NEGATIVE_INTERACTION, UNSAFE, UNKNOWN
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, candidate_a, candidate_b)
);

-- Cross-experiment learning
CREATE TABLE IF NOT EXISTS cross_experiment_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    objective_impacts TEXT NOT NULL,       -- JSON
    evidence_type TEXT NOT NULL,
    experiment_ids TEXT NOT NULL,          -- JSON
    correlation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Resource reservations
CREATE TABLE IF NOT EXISTS optimization_resource_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    amount REAL NOT NULL,
    state TEXT NOT NULL,                   -- AVAILABLE, RESERVED, CONSUMED, RELEASED, OVERCOMMITTED
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Portfolio lineage
CREATE TABLE IF NOT EXISTS optimization_portfolio_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    version TEXT NOT NULL,
    parent_version TEXT,
    reason TEXT,
    candidate_ids TEXT NOT NULL,           -- JSON
    experiment_ids TEXT NOT NULL,          -- JSON
    correlation_id TEXT,
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, version)
);

-- Portfolio audit events
CREATE TABLE IF NOT EXISTS optimization_portfolio_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_version TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT                -- JSON
);

COMMIT;
