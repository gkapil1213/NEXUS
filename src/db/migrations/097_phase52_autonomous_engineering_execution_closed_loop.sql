-- Phase 52: Autonomous Engineering Execution & Closed-Loop Control
CREATE TABLE IF NOT EXISTS execution_plans_phase52 (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, objective TEXT, target TEXT, provider TEXT,
    actions_json TEXT, prerequisites_json TEXT, expected_outcome TEXT, verification_strategy TEXT,
    rollback_strategy TEXT, risk TEXT, blast_radius TEXT, authorization TEXT, governance_state TEXT,
    approval_reference TEXT, idempotency_key TEXT NOT NULL UNIQUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_actions_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT, action_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    action_type TEXT NOT NULL, provider TEXT, target TEXT, input_reference TEXT, authorization TEXT,
    timeout_seconds INTEGER, retry_policy TEXT, rollback_reference TEXT, verification_reference TEXT,
    status TEXT NOT NULL DEFAULT 'pending', idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TIMESTAMP, completed_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_leases_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, lease_owner TEXT NOT NULL,
    acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP NOT NULL,
    renewed_at TIMESTAMP, state TEXT NOT NULL DEFAULT 'active', idempotency_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS execution_locks_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, resource_id TEXT NOT NULL, lock_type TEXT NOT NULL,
    acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP, state TEXT NOT NULL DEFAULT 'active',
    idempotency_key TEXT NOT NULL UNIQUE, UNIQUE(resource_id, lock_type)
);
CREATE TABLE IF NOT EXISTS execution_attempts_phase52 (
    id TEXT PRIMARY KEY, action_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'started',
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP, error TEXT, idempotency_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS execution_telemetry_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, action_id TEXT, event_type TEXT NOT NULL,
    event_data TEXT, timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_outcomes_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, outcome_state TEXT NOT NULL DEFAULT 'unknown',
    verification_ref TEXT, actual_state TEXT, expected_state TEXT, drift_detected INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_verifications_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT, timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_recoveries_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, recovery_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned', result TEXT, idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_rollbacks_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, reason TEXT, state TEXT NOT NULL DEFAULT 'planned',
    result TEXT, idempotency_key TEXT NOT NULL UNIQUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_circuit_breakers_phase52 (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'CLOSED', opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_incidents_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT, decision_id TEXT, target TEXT, provider TEXT,
    failure_category TEXT, severity TEXT NOT NULL, signature TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'open',
    impact TEXT, risk TEXT, recovery_state TEXT, rollback_state TEXT, evidence_refs TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_escalations_phase52 (
    id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, level TEXT NOT NULL, reason TEXT, target TEXT,
    state TEXT NOT NULL DEFAULT 'pending', idempotency_key TEXT NOT NULL UNIQUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_evidence_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, evidence_type TEXT NOT NULL,
    data TEXT, timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_audit_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT, decision_id TEXT, event_type TEXT NOT NULL, actor TEXT,
    action TEXT, previous_state TEXT, new_state TEXT, reason TEXT, timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_lineage_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, decision_id TEXT, plan_id TEXT, action_id TEXT,
    attempt_id TEXT, verification_id TEXT, recovery_id TEXT, rollback_id TEXT, incident_id TEXT,
    evidence_id TEXT, learning_outcome_id TEXT, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_learning_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, decision_type TEXT, execution_strategy TEXT,
    provider TEXT, target_class TEXT, success INTEGER, retries INTEGER, recovery TEXT, rollback TEXT,
    duration_seconds REAL, verification_result TEXT, regression INTEGER, final_outcome TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_replay_phase52 (
    id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, replayed_inputs TEXT, replayed_outputs TEXT,
    divergence_detected INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_phase52_plans_decision ON execution_plans_phase52(decision_id);
CREATE INDEX idx_phase52_actions_execution ON execution_actions_phase52(execution_id);
CREATE INDEX idx_phase52_leases_execution ON execution_leases_phase52(execution_id);
CREATE INDEX idx_phase52_attempts_action ON execution_attempts_phase52(action_id);
