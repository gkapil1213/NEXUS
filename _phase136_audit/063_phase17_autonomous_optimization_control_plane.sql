-- 063_phase17_autonomous_optimization_control_plane.sql

BEGIN;

CREATE TABLE IF NOT EXISTS control_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    objective_id TEXT NOT NULL,
    strategy_context TEXT NOT NULL,
    population_context TEXT NOT NULL,
    experiment_context TEXT NOT NULL,
    meta_experiment_context TEXT NOT NULL,
    portfolio_context TEXT NOT NULL,
    execution_context TEXT NOT NULL,
    governance_context TEXT NOT NULL,
    safety_context TEXT NOT NULL,
    version INTEGER NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS control_cycle_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL,
    snapshot_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cycle_id)
);

CREATE TABLE IF NOT EXISTS control_cycle_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    reason TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS control_cycle_recovery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL,
    recovery_action TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
