-- 059_phase17_population_experimentation_and_adaptive_selection.sql

BEGIN;

-- Population experiments
CREATE TABLE IF NOT EXISTS population_experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL UNIQUE,
    population_id TEXT NOT NULL,
    population_version INTEGER NOT NULL,
    strategy_ids TEXT NOT NULL,           -- JSON
    champion_strategy_id TEXT,
    challenger_strategy_id TEXT,
    experiment_type TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    objective TEXT NOT NULL,
    baseline TEXT NOT NULL,               -- JSON
    treatment TEXT NOT NULL,              -- JSON
    metrics TEXT NOT NULL,                -- JSON
    constraints TEXT NOT NULL,            -- JSON
    resource_budget REAL NOT NULL,
    minimum_evidence INTEGER NOT NULL,
    confidence_threshold REAL NOT NULL,
    safety_requirements TEXT NOT NULL,    -- JSON
    governance_requirements TEXT NOT NULL,-- JSON
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Experiment participants (many-to-many)
CREATE TABLE IF NOT EXISTS population_experiment_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    role TEXT NOT NULL,                   -- CHAMPION, CHALLENGER, BASELINE, CANDIDATE
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(experiment_id, strategy_id, role)
);

-- Experiment evidence
CREATE TABLE IF NOT EXISTS population_experiment_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    outcome TEXT NOT NULL,                -- JSON
    confidence REAL NOT NULL,
    evidence_level TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    durability REAL NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Experiment outcomes
CREATE TABLE IF NOT EXISTS population_experiment_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    population_version INTEGER NOT NULL,
    objective TEXT NOT NULL,
    metric TEXT NOT NULL,
    baseline REAL NOT NULL,
    treatment REAL NOT NULL,
    attribution_confidence REAL NOT NULL,
    evidence_level TEXT NOT NULL,
    outcome TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Experiment decisions
CREATE TABLE IF NOT EXISTS population_experiment_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Experiment audit events
CREATE TABLE IF NOT EXISTS population_experiment_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    experiment_id TEXT NOT NULL,
    population_id TEXT NOT NULL,
    population_version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

-- Experiment budgets
CREATE TABLE IF NOT EXISTS population_experiment_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    population_id TEXT NOT NULL,
    execution_budget REAL NOT NULL,
    compute_budget REAL NOT NULL,
    time_budget REAL NOT NULL,
    experiment_count_budget REAL NOT NULL,
    mutation_budget REAL NOT NULL,
    rollout_budget REAL NOT NULL,
    rollback_budget REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Experiment lineage relationships
CREATE TABLE IF NOT EXISTS population_experiment_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL,
    parent_lineage_ids TEXT NOT NULL,     -- JSON
    participating_lineage_ids TEXT NOT NULL, -- JSON
    shared_traits TEXT NOT NULL,          -- JSON
    successful_traits TEXT NOT NULL,      -- JSON
    failed_traits TEXT NOT NULL,          -- JSON
    transferable_evidence TEXT NOT NULL,  -- JSON
    incompatible_traits TEXT NOT NULL,    -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

COMMIT;
