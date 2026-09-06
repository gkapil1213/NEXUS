-- Phase 69: Autonomous Enterprise Learning & Continuous Improvement

CREATE TABLE IF NOT EXISTS phase69_learning_observations (
    id TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_id TEXT,
    event_data TEXT,
    status TEXT NOT NULL DEFAULT 'RAW',
    confidence REAL DEFAULT 0,
    evidence_refs TEXT,
    correlation_id TEXT,
    causation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_learning_correlations (
    id TEXT PRIMARY KEY,
    correlation_id TEXT NOT NULL UNIQUE,
    participant_ids TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    confidence REAL,
    supporting_evidence TEXT,
    contradictory_evidence TEXT,
    correlation_status TEXT NOT NULL DEFAULT 'PROPOSED',
    is_causal INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_learned_patterns (
    id TEXT PRIMARY KEY,
    pattern_id TEXT NOT NULL UNIQUE,
    description TEXT,
    inputs TEXT,
    observed_conditions TEXT,
    expected_outcome TEXT,
    supporting_evidence TEXT,
    confidence REAL,
    validation_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    last_observed_at TIMESTAMP,
    applicability_scope TEXT,
    risk_level TEXT NOT NULL DEFAULT 'LOW',
    lifecycle_state TEXT NOT NULL DEFAULT 'PROPOSED',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_validated_lessons (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL UNIQUE,
    pattern_id TEXT,
    lesson_content TEXT,
    evidence_refs TEXT,
    confidence REAL,
    affected_domains TEXT,
    limitations TEXT,
    applicability_constraints TEXT,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_improvement_candidates (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL UNIQUE,
    lesson_id TEXT,
    description TEXT,
    target TEXT,
    risk_level TEXT NOT NULL DEFAULT 'LOW',
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_adaptation_proposals (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    scope TEXT,
    risk_level TEXT NOT NULL DEFAULT 'LOW',
    governance_decision TEXT,
    approval_required INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_adaptation_decisions (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL UNIQUE,
    proposal_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_adaptation_validations (
    id TEXT PRIMARY KEY,
    validation_id TEXT NOT NULL UNIQUE,
    proposal_id TEXT NOT NULL,
    validation_result TEXT NOT NULL,
    expected_outcome TEXT,
    actual_outcome TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_learning_evidence (
    id TEXT PRIMARY KEY,
    evidence_id TEXT NOT NULL UNIQUE,
    observation_id TEXT,
    lesson_id TEXT,
    candidate_id TEXT,
    proposal_id TEXT,
    evidence_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT,
    source TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_learning_lineage (
    id TEXT PRIMARY KEY,
    observation_id TEXT,
    correlation_id TEXT,
    pattern_id TEXT,
    lesson_id TEXT,
    candidate_id TEXT,
    proposal_id TEXT,
    decision_id TEXT,
    validation_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase69_learning_replays (
    id TEXT PRIMARY KEY,
    replay_id TEXT NOT NULL UNIQUE,
    input_hash TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    divergence_detected INTEGER NOT NULL DEFAULT 0,
    divergence_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase69_observations_status ON phase69_learning_observations(status);
CREATE INDEX idx_phase69_patterns_state ON phase69_learned_patterns(lifecycle_state);
CREATE INDEX idx_phase69_proposals_status ON phase69_adaptation_proposals(status);
