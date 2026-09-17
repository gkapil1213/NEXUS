-- Phase 91: Autonomous Engineering Collective Intelligence & Negotiation
BEGIN;

CREATE TABLE IF NOT EXISTS collective_negotiation_sessions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    mission_id TEXT,
    workload_id TEXT,
    collective_id TEXT,
    required_capabilities TEXT,
    resource_requirements TEXT,
    deadline TEXT,
    risk_classification TEXT,
    governance_context TEXT,
    safety_context TEXT,
    approval_required INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'CREATED',
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_participants (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES collective_negotiation_sessions(id),
    participant_id TEXT NOT NULL,
    role TEXT,
    capability_id TEXT,
    trust_level TEXT DEFAULT 'UNKNOWN',
    authorization_ref TEXT,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, participant_id)
);

CREATE TABLE IF NOT EXISTS negotiation_proposals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES collective_negotiation_sessions(id),
    proposer_participant_id TEXT NOT NULL,
    proposal_type TEXT NOT NULL,
    target_participant_id TEXT,
    content TEXT,
    constraints TEXT,
    assumptions TEXT,
    expected_utility REAL,
    expected_risk REAL,
    confidence REAL,
    expiry TEXT,
    parent_proposal_id TEXT,
    fingerprint TEXT,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_proposal_versions (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL REFERENCES negotiation_proposals(id),
    version INTEGER NOT NULL,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(proposal_id, version)
);

CREATE TABLE IF NOT EXISTS negotiation_constraints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES collective_negotiation_sessions(id),
    constraint_type TEXT NOT NULL CHECK (constraint_type IN ('HARD','SOFT')),
    field TEXT NOT NULL,
    operator TEXT,
    value TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_rounds (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES collective_negotiation_sessions(id),
    round_number INTEGER NOT NULL,
    fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sender_participant_id TEXT NOT NULL,
    recipient_participant_id TEXT,
    message_type TEXT,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_offers (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    offer_content TEXT,
    expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_counteroffers (
    id TEXT PRIMARY KEY,
    offer_id TEXT NOT NULL,
    counteroffer_content TEXT,
    state TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    proposal_id TEXT,
    decision_type TEXT NOT NULL,
    actor_participant_id TEXT,
    rationale TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_contracts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES collective_negotiation_sessions(id),
    version INTEGER NOT NULL DEFAULT 1,
    contract_content TEXT,
    fingerprint TEXT,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    governance_result TEXT,
    safety_result TEXT,
    approval_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, version)
);

CREATE TABLE IF NOT EXISTS negotiation_assignments (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES negotiation_contracts(id),
    participant_id TEXT NOT NULL,
    role TEXT,
    capability_id TEXT,
    task_ownership TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_resource_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    amount REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_capability_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    participant_id TEXT,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_role_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    role TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_deadlocks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES collective_negotiation_sessions(id),
    deadlock_type TEXT NOT NULL,
    description TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_arbitrations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES collective_negotiation_sessions(id),
    winner_proposal_id TEXT,
    loser_proposal_id TEXT,
    rationale TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_escalations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES collective_negotiation_sessions(id),
    reason TEXT,
    level TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS negotiation_replay (
    id TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;