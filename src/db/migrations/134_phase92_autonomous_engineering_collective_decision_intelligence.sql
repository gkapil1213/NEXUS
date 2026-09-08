-- Phase 92: Autonomous Engineering Collective Decision Intelligence
BEGIN;

CREATE TABLE IF NOT EXISTS collective_decisions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    mission_id TEXT,
    workload_id TEXT,
    portfolio_id TEXT,
    decision_type TEXT NOT NULL,
    objective TEXT,
    decision_deadline TEXT,
    decision_status TEXT NOT NULL DEFAULT 'CREATED',
    decision_risk TEXT,
    decision_impact TEXT,
    decision_reversibility TEXT,
    decision_blast_radius REAL,
    decision_authority TEXT,
    required_quorum INTEGER DEFAULT 1,
    required_approval INTEGER DEFAULT 0,
    evidence_threshold REAL DEFAULT 0.5,
    confidence_threshold REAL DEFAULT 0.5,
    policy_version TEXT,
    safety_context TEXT,
    governance_context TEXT,
    decision_fingerprint TEXT,
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_contexts (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    context_data TEXT,
    fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_evidence (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    evidence_type TEXT NOT NULL,
    source TEXT,
    source_type TEXT,
    authority TEXT,
    confidence REAL,
    freshness TEXT,
    data TEXT,
    fingerprint TEXT,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_recommendations (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    participant_id TEXT NOT NULL,
    recommendation TEXT,
    rationale TEXT,
    evidence_refs TEXT,
    confidence REAL,
    uncertainty REAL,
    expected_outcomes TEXT,
    risks TEXT,
    alternatives TEXT,
    constraints TEXT,
    required_resources TEXT,
    execution_strategy TEXT,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    state TEXT NOT NULL DEFAULT 'SUBMITTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_alternatives (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    alternative_name TEXT NOT NULL,
    action TEXT,
    expected_benefit TEXT,
    expected_cost REAL,
    resource_impact REAL,
    risk REAL,
    blast_radius REAL,
    reversibility TEXT,
    deadline_fit REAL,
    governance_implications TEXT,
    safety_implications TEXT,
    verification_plan TEXT,
    rollback_plan TEXT,
    evidence_support TEXT,
    confidence REAL,
    uncertainty REAL,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_objectives (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    objective_type TEXT NOT NULL,
    objective_class TEXT NOT NULL DEFAULT 'SOFT' CHECK (objective_class IN ('HARD','SOFT')),
    weight REAL DEFAULT 1.0,
    threshold REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_constraints (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    constraint_type TEXT NOT NULL CHECK (constraint_type IN ('HARD','SOFT')),
    field TEXT NOT NULL,
    operator TEXT,
    value TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_dissent (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    participant_id TEXT,
    dissent_type TEXT,
    rationale TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_consensus (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    consensus_type TEXT,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_arbitrations (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    winner_alternative_id TEXT,
    loser_alternative_id TEXT,
    rationale TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_confidence (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    confidence REAL,
    factors TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_risk_assessments (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    risk_level TEXT,
    blast_radius REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_contracts (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    version INTEGER NOT NULL DEFAULT 1,
    contract_content TEXT,
    fingerprint TEXT,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    governance_result TEXT,
    safety_result TEXT,
    approval_state TEXT DEFAULT 'NONE',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(decision_id, version)
);

CREATE TABLE IF NOT EXISTS decision_approvals (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    approver TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_executions (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES collective_decisions(id),
    state TEXT NOT NULL DEFAULT 'PENDING',
    executed_at TEXT,
    completed_at TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_verifications (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'UNKNOWN',
    verified_at TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_outcomes (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    outcome_type TEXT,
    value REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_regret (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    regret_value REAL,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_replay (
    id TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_divergence (
    id TEXT PRIMARY KEY,
    original_fingerprint TEXT,
    replay_fingerprint TEXT,
    changed_inputs TEXT,
    classification TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS decision_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    incident_type TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS decision_evidence_records (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_audit (
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

CREATE TABLE IF NOT EXISTS decision_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_collective_decisions_project ON collective_decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_decision_evidence_decision ON decision_evidence(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_recommendations_decision ON decision_recommendations(decision_id);

COMMIT;