-- 057_phase17_strategy_evolution_and_multi_generation_learning.sql

BEGIN;

-- Strategy evolution generations
CREATE TABLE IF NOT EXISTS strategy_evolution_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id TEXT NOT NULL UNIQUE,
    strategy_id TEXT NOT NULL,
    parent_generation_id TEXT,
    root_strategy_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    source_evidence TEXT NOT NULL,         -- JSON
    learning_inputs TEXT NOT NULL,         -- JSON
    mutation_rationale TEXT,
    constraints TEXT NOT NULL,             -- JSON
    expected_objectives TEXT NOT NULL,     -- JSON
    confidence TEXT NOT NULL,
    validation_status TEXT NOT NULL,
    governance_status TEXT NOT NULL,
    rollout_status TEXT NOT NULL,
    outcome_status TEXT NOT NULL,
    retirement_status TEXT NOT NULL,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Strategy evolution candidates
CREATE TABLE IF NOT EXISTS strategy_evolution_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL UNIQUE,
    parent_strategy_id TEXT NOT NULL,
    parent_generation_id TEXT NOT NULL,
    proposed_generation INTEGER NOT NULL,
    tenant_id TEXT NOT NULL,
    source_evidence TEXT NOT NULL,         -- JSON
    change_set TEXT NOT NULL,              -- JSON
    expected_benefits TEXT NOT NULL,       -- JSON
    expected_risks TEXT NOT NULL,          -- JSON
    constraints TEXT NOT NULL,             -- JSON
    confidence TEXT NOT NULL,
    reason TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    fingerprint TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Strategy evolution deltas
CREATE TABLE IF NOT EXISTS strategy_evolution_deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_generation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    changed_fields TEXT NOT NULL,          -- JSON
    added_constraints TEXT NOT NULL,       -- JSON
    removed_constraints TEXT NOT NULL,     -- JSON
    objective_changes TEXT NOT NULL,       -- JSON
    risk_changes TEXT NOT NULL,            -- JSON
    resource_changes TEXT NOT NULL,        -- JSON
    expected_performance_changes TEXT NOT NULL, -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Strategy evolution evaluations (shadow, regression, confidence)
CREATE TABLE IF NOT EXISTS strategy_evolution_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    shadow_result TEXT,                    -- PASS/FAIL/INSUFFICIENT_DATA
    regression_result TEXT,                -- ACCEPT/REJECT/HOLD
    confidence_result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Strategy evolution decisions (governance, safety, arbitration)
CREATE TABLE IF NOT EXISTS strategy_evolution_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    decision_type TEXT NOT NULL,           -- GOVERNANCE, SAFETY, ARBITRATION, ROLLOUT, ROLLBACK, RETIREMENT
    decision_result TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Strategy evolution rollouts
CREATE TABLE IF NOT EXISTS strategy_evolution_rollouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollout_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    metrics TEXT NOT NULL,                 -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Strategy evolution rollbacks
CREATE TABLE IF NOT EXISTS strategy_evolution_rollbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollback_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    parent_generation_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Strategy evolution lineage
CREATE TABLE IF NOT EXISTS strategy_evolution_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    root_strategy_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    parent_generation_id TEXT,
    strategy_id TEXT NOT NULL,
    reason TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL,
    UNIQUE(root_strategy_id, generation_id)
);

-- Strategy evolution learning
CREATE TABLE IF NOT EXISTS strategy_evolution_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    candidate_id TEXT,
    outcome TEXT NOT NULL,
    evidence TEXT NOT NULL,                -- JSON
    failure_reason TEXT,
    successful_conditions TEXT,            -- JSON
    confidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Strategy evolution audit
CREATE TABLE IF NOT EXISTS strategy_evolution_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    candidate_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT                 -- JSON
);

COMMIT;
