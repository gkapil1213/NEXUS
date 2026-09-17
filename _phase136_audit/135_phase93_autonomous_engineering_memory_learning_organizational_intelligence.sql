-- Phase 93: Autonomous Engineering Memory, Learning & Organizational Intelligence
BEGIN;

CREATE TABLE IF NOT EXISTS engineering_memories (
    id TEXT PRIMARY KEY,
    memory_type TEXT NOT NULL CHECK (memory_type IN ('FACT','EVENT','EXPERIENCE','DECISION','PROCEDURE','INCIDENT','FAILURE','REMEDIATION','RECOVERY','ROLLBACK','VERIFICATION','PATTERN','OUTCOME','POLICY_OUTCOME','RESOURCE_BEHAVIOR','AGENT_BEHAVIOR','ORGANIZATIONAL_PATTERN','REGRET','PREDICTION','CALIBRATION','FALSE_POSITIVE','FALSE_NEGATIVE','DRIFT','SIMULATION','ACTUAL','SIM_ERROR','COUNTERFACTUAL','OBSERVED')),
    subject TEXT NOT NULL,
    scope TEXT,
    organization_id TEXT,
    project_id TEXT,
    environment TEXT,
    source TEXT,
    source_authority TEXT DEFAULT 'UNKNOWN',
    observed_at TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    validity_window TEXT,
    confidence REAL DEFAULT 0.5,
    freshness TEXT DEFAULT 'CURRENT',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    provenance TEXT,
    content_fingerprint TEXT,
    supersedes_ref TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS memory_versions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES engineering_memories(id),
    version INTEGER NOT NULL,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(memory_id, version)
);

CREATE TABLE IF NOT EXISTS engineering_episodes (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    project_id TEXT,
    environment TEXT,
    workload_id TEXT,
    mission_id TEXT,
    episode_type TEXT,
    state TEXT NOT NULL DEFAULT 'OPEN',
    outcome TEXT,
    participants TEXT,
    decisions TEXT,
    resources TEXT,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_sources (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    source_type TEXT,
    authority TEXT DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_patterns (
    id TEXT PRIMARY KEY,
    pattern_type TEXT NOT NULL,
    description TEXT,
    organization_id TEXT,
    project_id TEXT,
    environment TEXT,
    confidence REAL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    validation_state TEXT DEFAULT 'UNVALIDATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procedural_memories (
    id TEXT PRIMARY KEY,
    procedure_name TEXT NOT NULL,
    preconditions TEXT,
    required_capabilities TEXT,
    required_approvals TEXT,
    risk TEXT,
    expected_outcome TEXT,
    observed_success_rate REAL,
    failure_modes TEXT,
    verification_requirements TEXT,
    provenance TEXT,
    confidence REAL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_memories (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    context TEXT,
    alternatives TEXT,
    evidence TEXT,
    recommendations TEXT,
    dissent TEXT,
    consensus TEXT,
    chosen_option TEXT,
    confidence REAL,
    risk REAL,
    constraints TEXT,
    expected_outcome TEXT,
    actual_outcome TEXT,
    regret REAL,
    lessons TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incident_memories (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL UNIQUE,
    incident_type TEXT,
    severity TEXT,
    scope TEXT,
    affected_resources TEXT,
    affected_projects TEXT,
    affected_environments TEXT,
    root_cause TEXT,
    contributing_factors TEXT,
    response TEXT,
    recovery TEXT,
    rollback TEXT,
    verification TEXT,
    duration REAL,
    impact TEXT,
    recurrence INTEGER DEFAULT 0,
    resolution_quality TEXT,
    lessons TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failure_memories (
    id TEXT PRIMARY KEY,
    failure_signature TEXT NOT NULL,
    failure_class TEXT,
    trigger TEXT,
    affected_component TEXT,
    affected_scope TEXT,
    causal_evidence TEXT,
    recovery_strategy TEXT,
    rollback_strategy TEXT,
    verification_result TEXT,
    recurrence_frequency INTEGER DEFAULT 0,
    confidence REAL,
    last_observed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_retrievals (
    id TEXT PRIMARY KEY,
    query_context TEXT,
    retrieved_memory_id TEXT,
    similarity_score REAL,
    matched_attributes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_conflicts (
    id TEXT PRIMARY KEY,
    memory_a_id TEXT,
    memory_b_id TEXT,
    conflict_type TEXT,
    authority_a TEXT,
    authority_b TEXT,
    evidence_a TEXT,
    evidence_b TEXT,
    resolution_state TEXT DEFAULT 'UNRESOLVED',
    resolution_action TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_reconciliations (
    id TEXT PRIMARY KEY,
    conflict_id TEXT NOT NULL,
    resolution_action TEXT,
    resolved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_candidates (
    id TEXT PRIMARY KEY,
    memory_id TEXT,
    pattern_type TEXT,
    candidate_content TEXT,
    confidence REAL,
    state TEXT NOT NULL DEFAULT 'PENDING_VALIDATION',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_validations (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    validation_result TEXT,
    validated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_outcomes (
    id TEXT PRIMARY KEY,
    learning_type TEXT,
    entity_id TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_quality (
    id TEXT PRIMARY KEY,
    learning_type TEXT,
    quality_score REAL,
    measured_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_drift (
    id TEXT PRIMARY KEY,
    learning_type TEXT,
    pattern_id TEXT,
    drift_type TEXT,
    details TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS memory_quarantine (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    reason TEXT,
    quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_audit (
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

CREATE TABLE IF NOT EXISTS memory_replay (
    id TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;