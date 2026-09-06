-- Phase 61: Autonomous Release Governance, Change Control & Production Promotion

CREATE TABLE IF NOT EXISTS release_requests_phase61 (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    project_id TEXT,
    environment TEXT,
    requested_by TEXT,
    change_type TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'REQUESTED',
    idempotency_key TEXT NOT NULL UNIQUE,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS change_plans_phase61 (
    id TEXT PRIMARY KEY,
    release_request_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL UNIQUE,
    affected_components TEXT,
    affected_resources TEXT,
    dependencies TEXT,
    expected_changes TEXT,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_request_id) REFERENCES release_requests_phase61(id)
);

CREATE TABLE IF NOT EXISTS impact_assessments_phase61 (
    id TEXT PRIMARY KEY,
    release_request_id TEXT NOT NULL,
    affected_services TEXT,
    affected_environments TEXT,
    affected_resources TEXT,
    dependency_impact TEXT,
    data_impact TEXT,
    security_impact TEXT,
    reliability_impact TEXT,
    compliance_impact TEXT,
    cost_impact TEXT,
    blast_radius TEXT NOT NULL DEFAULT 'LOW',
    reversibility TEXT,
    confidence REAL,
    evidence_refs TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_request_id) REFERENCES release_requests_phase61(id)
);

CREATE TABLE IF NOT EXISTS release_candidates_phase61 (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL UNIQUE,
    project_id TEXT,
    source_revision TEXT,
    artifact_refs TEXT,
    plan_hash TEXT,
    evidence_hash TEXT,
    security_status TEXT,
    test_status TEXT,
    policy_status TEXT,
    environment TEXT,
    candidate_status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_promotions_phase61 (
    id TEXT PRIMARY KEY,
    release_candidate_id TEXT NOT NULL,
    source_environment TEXT,
    target_environment TEXT NOT NULL,
    approval_state TEXT NOT NULL DEFAULT 'PENDING',
    promotion_state TEXT NOT NULL DEFAULT 'REQUESTED',
    execution_id TEXT,
    verification_id TEXT,
    rollback_id TEXT,
    failure_reason TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_candidate_id) REFERENCES release_candidates_phase61(id)
);

CREATE TABLE IF NOT EXISTS release_gates_phase61 (
    id TEXT PRIMARY KEY,
    release_request_id TEXT NOT NULL,
    gate_name TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    evidence TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_request_id) REFERENCES release_requests_phase61(id)
);

CREATE TABLE IF NOT EXISTS production_approvals_phase61 (
    id TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL UNIQUE,
    release_candidate_id TEXT NOT NULL,
    approver TEXT,
    approval_state TEXT NOT NULL DEFAULT 'PENDING',
    approval_scope TEXT,
    expiration TIMESTAMP,
    reason TEXT,
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS post_release_observations_phase61 (
    id TEXT PRIMARY KEY,
    release_candidate_id TEXT NOT NULL,
    environment TEXT,
    observation_window TEXT,
    health_signals TEXT,
    error_rate REAL,
    incident_signals TEXT,
    regression_signals TEXT,
    reliability_state TEXT,
    observation_result TEXT,
    rollback_recommendation TEXT,
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_events_phase61 (
    id TEXT PRIMARY KEY,
    release_request_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    release_candidate_id TEXT,
    environment TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    evidence_ref TEXT,
    reason TEXT
);

CREATE INDEX idx_phase61_requests_status ON release_requests_phase61(status);
CREATE INDEX idx_phase61_promotions_candidate ON release_promotions_phase61(release_candidate_id);
