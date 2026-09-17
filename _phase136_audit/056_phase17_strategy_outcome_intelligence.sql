-- 056_phase17_strategy_outcome_intelligence.sql

BEGIN;

-- Strategy outcomes
CREATE TABLE IF NOT EXISTS strategy_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outcome_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    experiment_id TEXT,
    objective_id TEXT NOT NULL,
    baseline_metrics TEXT NOT NULL,
    expected_outcome TEXT NOT NULL,
    actual_outcome TEXT NOT NULL,
    delta TEXT NOT NULL,
    cost_impact REAL NOT NULL,
    reliability_impact REAL NOT NULL,
    latency_impact REAL NOT NULL,
    quality_impact REAL NOT NULL,
    resource_impact REAL NOT NULL,
    risk_impact REAL NOT NULL,
    confidence TEXT NOT NULL,
    observation_window_days INTEGER NOT NULL,
    outcome_timestamp TEXT NOT NULL,
    evidence_references TEXT NOT NULL,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outcome attribution
CREATE TABLE IF NOT EXISTS strategy_outcome_attributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    attribution_classification TEXT NOT NULL,
    evidence_quality TEXT NOT NULL,
    causal_confidence REAL NOT NULL,
    concurrent_strategies TEXT,
    overlapping_experiments TEXT,
    infrastructure_changes INTEGER,
    deployment_changes INTEGER,
    workload_changes INTEGER,
    external_conditions INTEGER,
    baseline_drift INTEGER,
    temporal_ordering INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Effectiveness history
CREATE TABLE IF NOT EXISTS strategy_effectiveness_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    success_rate REAL NOT NULL,
    regression_rate REAL NOT NULL,
    expected_vs_actual REAL NOT NULL,
    durability TEXT NOT NULL,
    stability TEXT NOT NULL,
    resource_efficiency REAL NOT NULL,
    risk_adjusted_value REAL NOT NULL,
    repeated_failure_pattern INTEGER NOT NULL,
    environment_specific_performance TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Confidence calibration
CREATE TABLE IF NOT EXISTS strategy_confidence_calibrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    predicted_confidence TEXT NOT NULL,
    observed_success INTEGER NOT NULL,
    sample_size INTEGER NOT NULL,
    calibration_result TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Drift events
CREATE TABLE IF NOT EXISTS strategy_drift_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    drift_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    baseline TEXT NOT NULL,
    recent TEXT NOT NULL,
    threshold REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Adaptation proposals
CREATE TABLE IF NOT EXISTS strategy_adaptation_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    lineage TEXT NOT NULL,
    failure_evidence TEXT NOT NULL,
    observed_regression TEXT,
    suspected_cause TEXT,
    proposed_adjustment TEXT,
    expected_benefit REAL NOT NULL,
    expected_risk TEXT NOT NULL,
    confidence TEXT NOT NULL,
    evidence_references TEXT NOT NULL,
    rollback_plan TEXT,
    validation_plan TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

-- Failure memory
CREATE TABLE IF NOT EXISTS strategy_failure_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    failure_pattern TEXT NOT NULL,
    conditions TEXT NOT NULL,
    affected_objectives TEXT NOT NULL,
    attempted_remediation TEXT,
    result TEXT,
    recovery_time REAL NOT NULL,
    recurrence_count INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

-- Learning events
CREATE TABLE IF NOT EXISTS strategy_learning_events (
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
    redacted_metadata TEXT
);

-- Retirement candidates
CREATE TABLE IF NOT EXISTS strategy_retirement_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    evidence_refs TEXT NOT NULL,
    repeated_regression INTEGER NOT NULL,
    persistent_low_effectiveness INTEGER NOT NULL,
    excessive_cost INTEGER NOT NULL,
    excessive_risk INTEGER NOT NULL,
    obsolete_assumptions INTEGER NOT NULL,
    environmental_incompatibility INTEGER NOT NULL,
    superior_strategy_exists INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    governance_decision TEXT NOT NULL,
    rollback_path TEXT,
    retirement_decision TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

COMMIT;
