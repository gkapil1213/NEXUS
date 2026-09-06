-- Phase 67: Autonomous Enterprise Control, Policy & Decision Intelligence

CREATE TABLE IF NOT EXISTS policies_phase67 (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    policy_type TEXT NOT NULL,
    scope TEXT,
    priority INTEGER DEFAULT 0,
    effect TEXT NOT NULL,
    conditions TEXT,
    constraints TEXT,
    enforcement_mode TEXT NOT NULL DEFAULT 'REQUIRE_APPROVAL',
    approval_requirement TEXT,
    risk_threshold TEXT,
    effective_from TIMESTAMP,
    effective_until TIMESTAMP,
    enabled INTEGER NOT NULL DEFAULT 1,
    owner TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(policy_id, policy_version)
);

CREATE TABLE IF NOT EXISTS decisions_phase67 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL UNIQUE,
    request_id TEXT,
    correlation_id TEXT,
    decision_type TEXT NOT NULL,
    actor TEXT,
    actor_type TEXT,
    target TEXT,
    environment TEXT,
    requested_action TEXT,
    context TEXT,
    policy_inputs TEXT,
    risk_inputs TEXT,
    affected_resources TEXT,
    blast_radius TEXT,
    confidence REAL,
    policy_results TEXT,
    risk_assessment TEXT,
    required_approval_level TEXT,
    authorization_status TEXT NOT NULL DEFAULT 'PENDING',
    decision_outcome TEXT NOT NULL DEFAULT 'PENDING',
    constraints TEXT,
    explanation TEXT,
    evidence_references TEXT,
    lineage_references TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    evaluated_at TIMESTAMP,
    expires_at TIMESTAMP,
    version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS policy_evaluations_phase67 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    outcome TEXT NOT NULL,
    rationale TEXT,
    input_hash TEXT NOT NULL,
    evaluation_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES decisions_phase67(id)
);

CREATE TABLE IF NOT EXISTS policy_conflicts_phase67 (
    id TEXT PRIMARY KEY,
    policy_a_id TEXT NOT NULL,
    policy_b_id TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(policy_a_id, policy_b_id)
);

CREATE TABLE IF NOT EXISTS decision_risk_assessments_phase67 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    risk_score REAL,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    contributing_factors TEXT,
    mitigations TEXT,
    residual_risk TEXT,
    approval_requirement TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES decisions_phase67(id)
);

CREATE TABLE IF NOT EXISTS decision_authorizations_phase67 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    authorization_status TEXT NOT NULL,
    reason TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS decision_approvals_phase67 (
    id TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL UNIQUE,
    decision_id TEXT NOT NULL,
    required_role TEXT,
    requested_by TEXT,
    approved_by TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    reason TEXT,
    scope TEXT,
    expiration TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    evidence_references TEXT
);

CREATE TABLE IF NOT EXISTS decision_escalations_phase67 (
    id TEXT PRIMARY KEY,
    escalation_id TEXT NOT NULL UNIQUE,
    decision_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    reason TEXT,
    destination TEXT,
    deadline TIMESTAMP,
    escalation_level TEXT NOT NULL DEFAULT 'L1',
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS decision_evidence_phase67 (
    id TEXT PRIMARY KEY,
    evidence_id TEXT NOT NULL UNIQUE,
    decision_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT,
    source TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase67_policies_id ON policies_phase67(policy_id);
CREATE INDEX idx_phase67_decisions_status ON decisions_phase67(decision_outcome);
CREATE INDEX idx_phase67_evaluations_decision ON policy_evaluations_phase67(decision_id);
