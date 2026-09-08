-- Phase 88: Autonomous Engineering Organizational Operating Loop
BEGIN;

CREATE TABLE IF NOT EXISTS organizational_operating_cycles (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    cycle_version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'CREATED',
    parent_cycle_id TEXT,
    trigger TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_state_snapshots (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    snapshot_type TEXT NOT NULL,
    state_json TEXT,
    provenance TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_state_changes (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategic_drift_assessments (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    drift_type TEXT NOT NULL,
    severity TEXT,
    confidence REAL,
    affected_entities TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operational_drift_assessments (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    drift_type TEXT NOT NULL,
    severity TEXT,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_decision_triggers (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_fingerprint TEXT,
    source_entity TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(trigger_fingerprint)
);

CREATE TABLE IF NOT EXISTS autonomous_decisions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    rationale TEXT,
    confidence REAL,
    governance_result TEXT,
    safety_result TEXT,
    approval_required INTEGER NOT NULL DEFAULT 0,
    decision_version INTEGER NOT NULL DEFAULT 1,
    policy_version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_cycle_plans (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    plan_type TEXT,
    content TEXT,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_cycle_actions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS replanning_requests (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    reason TEXT,
    new_plan_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resource_reallocation_decisions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    resource_type TEXT,
    entity_id TEXT,
    amount REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_throttle_decisions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    throttle_level TEXT,
    target_scope TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizational_interventions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    intervention_type TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS human_interventions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    action TEXT,
    actor TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_cycle_outcomes (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    outcome_type TEXT,
    value REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outcome_verifications (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'UNKNOWN',
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS corrective_actions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    action_type TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stabilization_actions (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    action_type TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_loop_failures (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    failure_type TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_loop_incidents (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    incident_type TEXT,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operating_loop_evidence (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    evidence_type TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_loop_audit (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    event_type TEXT,
    entity_type TEXT,
    entity_id TEXT,
    actor TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_loop_lineage (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    phase TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_loop_learning (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    learning_type TEXT,
    entity_id TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operating_loop_replays (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    fingerprint TEXT,
    divergent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;