-- Phase 51: Autonomous Engineering Decision Intelligence & Unified Control Plane

CREATE TABLE IF NOT EXISTS engineering_decisions_phase51 (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    correlation_id TEXT,
    decision_type TEXT NOT NULL,
    subject TEXT,
    context_snapshot TEXT,
    evidence_refs TEXT,
    candidate_actions TEXT,
    selected_action TEXT,
    confidence REAL,
    expected_benefit TEXT,
    expected_risk TEXT,
    blast_radius TEXT,
    reversibility TEXT,
    policy_result TEXT,
    approval_requirement TEXT,
    authorization_result TEXT,
    decision_status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS decision_contexts_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT,
    context_type TEXT NOT NULL,
    context_data TEXT,
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_candidates_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    candidate_action TEXT NOT NULL,
    score REAL,
    reasons TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_evaluations_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    reliability_risk TEXT,
    security_risk TEXT,
    compliance_risk TEXT,
    delivery_risk TEXT,
    operational_risk TEXT,
    cost_impact TEXT,
    capacity_impact TEXT,
    customer_impact TEXT,
    dependency_impact TEXT,
    blast_radius TEXT,
    reversibility TEXT,
    evidence_confidence REAL,
    overall_score REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_conflicts_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_governance_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_safety_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    safe INTEGER NOT NULL DEFAULT 1,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_approvals_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    approver TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    approved_at TIMESTAMP,
    expires_at TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_executions_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_verifications_phase51 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES decision_executions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_rollbacks_phase51 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES decision_executions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_circuit_breakers_phase51 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS decision_incidents_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_evidence_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_audit_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_lineage_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    source_signal_id TEXT,
    change_id TEXT,
    deployment_id TEXT,
    release_id TEXT,
    resource_id TEXT,
    policy_id TEXT,
    execution_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_learning_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    predicted_outcome TEXT,
    actual_outcome TEXT,
    prediction_error REAL,
    action_effectiveness REAL,
    risk_accuracy REAL,
    confidence_accuracy REAL,
    rollback_frequency REAL,
    approval_frequency REAL,
    policy_blocks INTEGER,
    recurring_failure_pattern TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE TABLE IF NOT EXISTS decision_replay_phase51 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    replayed_inputs TEXT,
    replayed_outputs TEXT,
    divergence_detected INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES engineering_decisions_phase51(id)
);

CREATE INDEX idx_phase51_decisions_status ON engineering_decisions_phase51(decision_status);
CREATE INDEX idx_phase51_decisions_request ON engineering_decisions_phase51(request_id);
CREATE INDEX idx_phase51_executions_decision ON decision_executions_phase51(decision_id);