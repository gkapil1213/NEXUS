-- 054_phase17_autonomous_strategy_synthesis.sql

BEGIN;

-- Strategy definitions
CREATE TABLE IF NOT EXISTS optimization_strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    portfolio_refs TEXT NOT NULL,         -- JSON
    actions TEXT NOT NULL,                -- JSON
    objectives TEXT NOT NULL,             -- JSON
    expected_outcomes TEXT NOT NULL,      -- JSON
    predicted_cost REAL NOT NULL,
    predicted_reliability_impact REAL NOT NULL,
    predicted_risk TEXT NOT NULL,
    confidence TEXT NOT NULL,
    evidence_refs TEXT NOT NULL,          -- JSON
    interaction_effects TEXT NOT NULL,    -- JSON
    constraint_results TEXT NOT NULL,     -- JSON
    governance_status TEXT NOT NULL,
    safety_status TEXT NOT NULL,
    lifecycle_status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Strategy candidates
CREATE TABLE IF NOT EXISTS optimization_strategy_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL UNIQUE,
    strategy_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    objective_impacts TEXT NOT NULL,      -- JSON
    expected_benefit REAL NOT NULL,
    confidence TEXT NOT NULL,
    risk TEXT NOT NULL,
    evidence_refs TEXT NOT NULL,          -- JSON
    resource_requirements TEXT NOT NULL,  -- JSON
    interaction_effects TEXT NOT NULL,    -- JSON
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Strategy objectives
CREATE TABLE IF NOT EXISTS optimization_strategy_objectives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    target REAL NOT NULL,
    weight REAL NOT NULL,
    priority INTEGER NOT NULL,
    hard INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    source TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Strategy interactions
CREATE TABLE IF NOT EXISTS optimization_strategy_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_ids TEXT NOT NULL,           -- JSON array
    interaction_type TEXT NOT NULL,
    evidence_quality REAL NOT NULL,
    temporal_validity INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Strategy scores
CREATE TABLE IF NOT EXISTS optimization_strategy_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    score REAL NOT NULL,
    components TEXT NOT NULL,             -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Strategy decisions
CREATE TABLE IF NOT EXISTS optimization_strategy_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    decision_type TEXT NOT NULL,          -- ARBITRATION, GOVERNANCE, SAFETY, RESOURCE, ROLLOUT, VERIFICATION, ROLLBACK
    decision_result TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Strategy lineage
CREATE TABLE IF NOT EXISTS optimization_strategy_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    version TEXT NOT NULL,
    parent_version TEXT,
    candidate_ids TEXT NOT NULL,          -- JSON
    portfolio_ids TEXT NOT NULL,          -- JSON
    experiment_ids TEXT NOT NULL,         -- JSON
    policy_ids TEXT NOT NULL,             -- JSON
    evidence_refs TEXT NOT NULL,          -- JSON
    reason TEXT,
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(strategy_id, version)
);

-- Strategy audit events
CREATE TABLE IF NOT EXISTS optimization_strategy_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT               -- JSON
);

COMMIT;
