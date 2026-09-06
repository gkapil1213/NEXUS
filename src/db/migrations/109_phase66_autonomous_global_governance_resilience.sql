-- Phase 66: Autonomous Global System Governance & Resilience

CREATE TABLE IF NOT EXISTS governance_policies_phase66 (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL UNIQUE,
    policy_version TEXT NOT NULL,
    policy_type TEXT NOT NULL,
    scope TEXT,
    priority INTEGER DEFAULT 0,
    rules TEXT,
    enforcement_mode TEXT NOT NULL DEFAULT 'REQUIRE_APPROVAL',
    effective_at TIMESTAMP,
    expires_at TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS governance_decisions_phase66 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL UNIQUE,
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    rationale TEXT,
    input_hash TEXT NOT NULL,
    decision_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resilience_domains_phase66 (
    id TEXT PRIMARY KEY,
    domain_id TEXT NOT NULL UNIQUE,
    environment_id TEXT,
    region TEXT,
    zone TEXT,
    dependency_group TEXT,
    criticality TEXT NOT NULL DEFAULT 'LOW',
    failure_domain TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resilience_events_phase66 (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    domain_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    state TEXT NOT NULL DEFAULT 'OPEN',
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recovery_plans_phase66 (
    id TEXT PRIMARY KEY,
    recovery_plan_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    target_scope TEXT,
    recovery_strategy TEXT NOT NULL,
    prerequisites TEXT,
    maximum_blast_radius TEXT NOT NULL DEFAULT 'MEDIUM',
    approval_policy TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recovery_executions_phase66 (
    id TEXT PRIMARY KEY,
    recovery_execution_id TEXT NOT NULL UNIQUE,
    recovery_plan_id TEXT NOT NULL,
    trigger_event_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'STARTED',
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    result TEXT,
    error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS governance_actions_phase66 (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL UNIQUE,
    decision_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target TEXT,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    status TEXT NOT NULL DEFAULT 'PLANNED',
    authorization_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    executed_at TIMESTAMP,
    result TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blast_radius_assessments_phase66 (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL UNIQUE,
    action_id TEXT NOT NULL,
    affected_scope TEXT,
    affected_resources TEXT,
    estimated_impact TEXT,
    risk_score INTEGER NOT NULL DEFAULT 0,
    allowed INTEGER NOT NULL DEFAULT 1,
    rationale TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS escalations_phase66 (
    id TEXT PRIMARY KEY,
    escalation_id TEXT NOT NULL UNIQUE,
    decision_id TEXT,
    severity TEXT NOT NULL DEFAULT 'HIGH',
    escalation_level TEXT NOT NULL DEFAULT 'L1',
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS governance_evidence_phase66 (
    id TEXT PRIMARY KEY,
    evidence_id TEXT NOT NULL UNIQUE,
    decision_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT,
    source TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase66_policies_status ON governance_policies_phase66(status);
CREATE INDEX idx_phase66_decisions_policy ON governance_decisions_phase66(policy_id);
CREATE INDEX idx_phase66_recovery_plans_status ON recovery_plans_phase66(status);
CREATE INDEX idx_phase66_escalations_status ON escalations_phase66(status);
