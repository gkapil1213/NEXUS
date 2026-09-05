-- 053_phase17_long_horizon_optimization_intelligence.sql

BEGIN;

-- Long-horizon optimization memory
CREATE TABLE IF NOT EXISTS optimization_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    optimization_id TEXT NOT NULL,
    portfolio_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    objective TEXT NOT NULL,
    baseline TEXT NOT NULL,               -- JSON
    treatment TEXT NOT NULL,              -- JSON
    observed_result TEXT NOT NULL,        -- JSON
    confidence TEXT NOT NULL,
    duration_hours INTEGER NOT NULL,
    environment TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource_cost REAL NOT NULL,
    risk TEXT NOT NULL,
    rollback_history TEXT,                -- JSON
    evidence_references TEXT,             -- JSON
    causal_confidence TEXT NOT NULL,
    durability_classification TEXT,
    status TEXT NOT NULL,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Temporal outcome analysis
CREATE TABLE IF NOT EXISTS optimization_temporal_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    optimization_id TEXT NOT NULL,
    temporal_classification TEXT NOT NULL,
    observations TEXT NOT NULL,           -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Durability evaluations
CREATE TABLE IF NOT EXISTS optimization_durability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    optimization_id TEXT NOT NULL,
    durability_classification TEXT NOT NULL,
    metrics TEXT NOT NULL,                -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Return analysis
CREATE TABLE IF NOT EXISTS optimization_return_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    optimization_id TEXT NOT NULL,
    return_classification TEXT NOT NULL,
    metrics TEXT NOT NULL,                -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Fatigue states
CREATE TABLE IF NOT EXISTS optimization_fatigue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    fatigue_state TEXT NOT NULL,
    metrics TEXT NOT NULL,                -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Strategy interactions
CREATE TABLE IF NOT EXISTS optimization_strategy_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_a TEXT NOT NULL,
    strategy_b TEXT NOT NULL,
    interaction_classification TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, strategy_a, strategy_b)
);

-- Historical evidence
CREATE TABLE IF NOT EXISTS optimization_historical_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    scope TEXT NOT NULL,
    environment TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    regression_count INTEGER NOT NULL DEFAULT 0,
    similar_experiments TEXT,             -- JSON
    known_interactions TEXT,              -- JSON
    durability_evidence TEXT,             -- JSON
    risk_history TEXT,                    -- JSON
    confidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Failure memory
CREATE TABLE IF NOT EXISTS optimization_failure_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    failure_reason TEXT NOT NULL,
    failure_scope TEXT NOT NULL,
    failure_evidence TEXT NOT NULL,       -- JSON
    failure_confidence TEXT NOT NULL,
    last_observed TEXT NOT NULL,
    revalidation_allowed INTEGER NOT NULL DEFAULT 0
);

-- Long-horizon decisions
CREATE TABLE IF NOT EXISTS optimization_long_horizon_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    decision_id TEXT NOT NULL UNIQUE,
    decision_status TEXT NOT NULL,
    short_term_impact REAL NOT NULL,
    medium_term_impact REAL NOT NULL,
    long_term_impact REAL NOT NULL,
    durability TEXT NOT NULL,
    confidence TEXT NOT NULL,
    risk TEXT NOT NULL,
    resource_cost REAL NOT NULL,
    rollback_cost REAL NOT NULL,
    governance_allowed INTEGER NOT NULL,
    safety_allowed INTEGER NOT NULL,
    resource_budget_exceeded INTEGER NOT NULL,
    stale_telemetry INTEGER NOT NULL,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recommendations
CREATE TABLE IF NOT EXISTS optimization_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommendation_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    recommendation_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,               -- JSON
    confidence TEXT NOT NULL,
    affected_objective TEXT NOT NULL,
    expected_benefit REAL NOT NULL,
    expected_risk TEXT NOT NULL,
    historical_evidence TEXT NOT NULL,    -- JSON
    freshness TEXT NOT NULL,
    governing_policy TEXT NOT NULL,
    decision_lineage TEXT NOT NULL,       -- JSON
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Decision lineage
CREATE TABLE IF NOT EXISTS optimization_decision_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    parent_decision_id TEXT,
    portfolio_id TEXT,
    candidate_id TEXT,
    policy_version TEXT,
    correlation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
