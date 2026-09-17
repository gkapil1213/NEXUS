-- Phase 80: Autonomous Closed-Loop Engineering Operations & Adaptive Control
BEGIN;

CREATE TABLE IF NOT EXISTS operational_baselines (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    baseline_value REAL NOT NULL,
    baseline_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id, metric, baseline_version)
);

CREATE TABLE IF NOT EXISTS operational_observations (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    observed_value REAL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_deviations (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    observed_value REAL,
    expected_value REAL,
    threshold REAL,
    deviation REAL,
    severity TEXT NOT NULL DEFAULT 'WARNING',
    confidence REAL NOT NULL DEFAULT 0.5,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    failure_domain TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_diagnoses (
    id TEXT PRIMARY KEY,
    deviation_id TEXT NOT NULL,
    root_cause TEXT NOT NULL DEFAULT 'ROOT_CAUSE_UNKNOWN',
    confidence REAL NOT NULL DEFAULT 0.5,
    evidence_ids TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_impacts (
    id TEXT PRIMARY KEY,
    deviation_id TEXT NOT NULL,
    affected_workloads TEXT,
    affected_projects TEXT,
    affected_environments TEXT,
    affected_fleets TEXT,
    affected_providers TEXT,
    affected_regions TEXT,
    blast_radius REAL,
    expected_duration REAL,
    recovery_options TEXT,
    rollback_options TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_decisions_phase80 (
    id TEXT PRIMARY KEY,
    deviation_id TEXT NOT NULL,
    decision_type TEXT NOT NULL CHECK (decision_type IN ('IGNORE','OBSERVE','ALERT','INVESTIGATE','ADJUST','RETRY','RECOVER','ROLLBACK','RESCHEDULE','REBALANCE','SCALE','FAILOVER','HALT','APPROVAL_REQUIRED')),
    rationale TEXT,
    policy_version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_policy_versions (
    id TEXT PRIMARY KEY,
    policy_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    thresholds TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS adaptive_control_actions (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    action_value REAL,
    min_value REAL,
    max_value REAL,
    step_size REAL,
    rate_limit REAL,
    cooldown_seconds INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_cooldowns (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    cooldown_until TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id, action_type)
);

CREATE TABLE IF NOT EXISTS control_action_budgets (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    max_attempts INTEGER NOT NULL,
    used_attempts INTEGER NOT NULL DEFAULT 0,
    window_seconds INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS control_oscillations (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    oscillation_count INTEGER NOT NULL DEFAULT 0,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remediation_plans (
    id TEXT PRIMARY KEY,
    deviation_id TEXT NOT NULL,
    diagnosis_id TEXT,
    action_type TEXT NOT NULL,
    target TEXT,
    constraints TEXT,
    rollback_plan TEXT,
    verification_plan TEXT,
    state TEXT NOT NULL DEFAULT 'PLANNED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remediation_attempts (
    id TEXT PRIMARY KEY,
    remediation_plan_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'EXECUTING',
    started_at TEXT,
    completed_at TEXT,
    failure_reason TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remediation_verifications (
    id TEXT PRIMARY KEY,
    remediation_attempt_id TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'UNKNOWN',
    verified_at TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stabilization_assessments (
    id TEXT PRIMARY KEY,
    remediation_attempt_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'UNKNOWN',
    assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_regressions (
    id TEXT PRIMARY KEY,
    remediation_attempt_id TEXT,
    entity_type TEXT,
    entity_id TEXT,
    regression_type TEXT,
    severity TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admission_decisions (
    id TEXT PRIMARY KEY,
    workload_id TEXT,
    project_id TEXT,
    environment TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('ADMIT','DEFER','REJECT')),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backpressure_events (
    id TEXT PRIMARY KEY,
    trigger_metric TEXT,
    threshold REAL,
    current_value REAL,
    action TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS operational_alerts (
    id TEXT PRIMARY KEY,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    entity_id TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operational_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operational_escalations (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    reason TEXT,
    level TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operational_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    policy_version TEXT,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operational_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operational_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operational_replay_records (
    id TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_op_baselines_entity ON operational_baselines(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_op_deviations_entity ON operational_deviations(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_op_diagnoses_deviation ON operational_diagnoses(deviation_id);
CREATE INDEX IF NOT EXISTS idx_control_decisions_phase80_deviation ON control_decisions_phase80(deviation_id);
CREATE INDEX IF NOT EXISTS idx_remediation_plans_deviation ON remediation_plans(deviation_id);
CREATE INDEX IF NOT EXISTS idx_op_circuit_breakers_scope ON operational_circuit_breakers(scope, entity_id);

COMMIT;
