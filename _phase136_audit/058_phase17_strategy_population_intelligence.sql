-- 058_phase17_strategy_population_intelligence.sql

BEGIN;

-- Strategy populations
CREATE TABLE IF NOT EXISTS strategy_populations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    population_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    strategy_ids TEXT NOT NULL,           -- JSON
    generation_ids TEXT NOT NULL,         -- JSON
    lineage_ids TEXT NOT NULL,            -- JSON
    population_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    active_strategy_id TEXT,
    challenger_strategy_ids TEXT NOT NULL, -- JSON
    retired_strategy_ids TEXT NOT NULL,    -- JSON
    population_health TEXT NOT NULL,
    diversity_score REAL NOT NULL,
    convergence_score REAL NOT NULL,
    stagnation_score REAL NOT NULL,
    exploration_pressure REAL NOT NULL,
    exploitation_pressure REAL NOT NULL,
    population_confidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Population candidates
CREATE TABLE IF NOT EXISTS strategy_population_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    objective_profile TEXT NOT NULL,     -- JSON
    behavioral_dimensions TEXT NOT NULL, -- JSON
    resource_profile TEXT NOT NULL,      -- JSON
    failure_patterns TEXT NOT NULL,      -- JSON
    status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Dominance results
CREATE TABLE IF NOT EXISTS strategy_population_dominance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    dimensions TEXT NOT NULL,             -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pareto frontier
CREATE TABLE IF NOT EXISTS strategy_population_pareto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    member_strategy_ids TEXT NOT NULL,    -- JSON
    dimensions TEXT NOT NULL,             -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Diversity measurements
CREATE TABLE IF NOT EXISTS strategy_population_diversity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    diversity_status TEXT NOT NULL,
    metrics TEXT NOT NULL,                -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Redundancy classifications
CREATE TABLE IF NOT EXISTS strategy_population_redundancy (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    strategy_a TEXT NOT NULL,
    strategy_b TEXT NOT NULL,
    classification TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Champion/challenger relationships
CREATE TABLE IF NOT EXISTS strategy_champion_challenger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    champion_strategy_id TEXT NOT NULL,
    challenger_strategy_ids TEXT NOT NULL, -- JSON
    champion_protected INTEGER NOT NULL,
    decision TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Population health records
CREATE TABLE IF NOT EXISTS strategy_population_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    health_status TEXT NOT NULL,
    metrics TEXT NOT NULL,                -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Evolution pressure records
CREATE TABLE IF NOT EXISTS strategy_population_pressure (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    exploration_pressure REAL NOT NULL,
    exploitation_pressure REAL NOT NULL,
    mutation_pressure REAL NOT NULL,
    preservation_pressure REAL NOT NULL,
    retirement_pressure REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stagnation records
CREATE TABLE IF NOT EXISTS strategy_population_stagnation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    stagnation_status TEXT NOT NULL,
    evidence TEXT NOT NULL,               -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Population decisions
CREATE TABLE IF NOT EXISTS strategy_population_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    decision_result TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Population rollouts
CREATE TABLE IF NOT EXISTS strategy_population_rollouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollout_id TEXT NOT NULL UNIQUE,
    population_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    metrics TEXT NOT NULL,                -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Population rollbacks
CREATE TABLE IF NOT EXISTS strategy_population_rollbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollback_id TEXT NOT NULL UNIQUE,
    population_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    target_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Cross-lineage learning
CREATE TABLE IF NOT EXISTS strategy_cross_lineage_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    source_lineage_ids TEXT NOT NULL,     -- JSON
    reusable_characteristics TEXT NOT NULL, -- JSON
    repeated_failure_patterns TEXT NOT NULL, -- JSON
    common_regressions TEXT NOT NULL,     -- JSON
    complementary_strategies TEXT NOT NULL, -- JSON
    transferable_improvements TEXT NOT NULL, -- JSON
    recommendation TEXT,
    confidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Population audit events
CREATE TABLE IF NOT EXISTS strategy_population_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    population_version INTEGER NOT NULL,
    strategy_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

COMMIT;
