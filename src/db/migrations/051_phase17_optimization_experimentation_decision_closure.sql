-- 051_phase17_optimization_experimentation_decision_closure.sql

BEGIN;

-- Optimization hypotheses
CREATE TABLE IF NOT EXISTS optimization_hypotheses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hypothesis_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    worker_fleet_id TEXT NOT NULL,
    source_policy_version TEXT NOT NULL,
    source_evolution_proposal TEXT,
    objective TEXT NOT NULL,
    baseline_metrics TEXT NOT NULL,           -- JSON
    expected_improvement TEXT NOT NULL,       -- JSON
    maximum_acceptable_regression TEXT NOT NULL, -- JSON
    risk_level TEXT NOT NULL,
    confidence_requirement TEXT NOT NULL,
    experiment_scope TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Optimization baselines (immutable)
CREATE TABLE IF NOT EXISTS optimization_baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    baseline_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    hypothesis_id TEXT NOT NULL,
    baseline_version TEXT NOT NULL,
    baseline_window_start TEXT NOT NULL,
    baseline_window_end TEXT NOT NULL,
    metrics TEXT NOT NULL,                    -- JSON
    telemetry_freshness TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    fleet_state TEXT,
    incident_state TEXT,
    release_state TEXT,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    UNIQUE(tenant_id, hypothesis_id, baseline_version)
);

-- Optimization experiments
CREATE TABLE IF NOT EXISTS optimization_experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL UNIQUE,
    hypothesis_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    control_group TEXT,
    treatment_group TEXT NOT NULL,
    allocation_percent INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    maximum_duration_hours INTEGER NOT NULL,
    minimum_sample_size INTEGER NOT NULL,
    maximum_blast_radius INTEGER NOT NULL,
    abort_thresholds TEXT NOT NULL,           -- JSON
    success_thresholds TEXT NOT NULL,         -- JSON
    status TEXT NOT NULL,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Optimization decision closures
CREATE TABLE IF NOT EXISTS optimization_decision_closures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL UNIQUE,
    experiment_id TEXT NOT NULL,
    hypothesis_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    causal_classification TEXT NOT NULL,
    confidence TEXT NOT NULL,
    metric_summary TEXT NOT NULL,             -- JSON
    risk_summary TEXT,
    safety_decision TEXT NOT NULL,
    governance_decision TEXT NOT NULL,
    rollout_summary TEXT,
    outcome TEXT NOT NULL,
    reason TEXT,
    correlation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Optimization audit events
CREATE TABLE IF NOT EXISTS optimization_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    experiment_id TEXT,
    hypothesis_id TEXT,
    actor TEXT,
    action TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
