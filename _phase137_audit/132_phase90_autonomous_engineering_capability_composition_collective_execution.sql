-- Phase 90: Autonomous Engineering Capability Composition, Agent Collaboration & Collective Execution
BEGIN;

CREATE TABLE IF NOT EXISTS collective_execution_domains (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    project_scope TEXT,
    environment_scope TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE',
    governance_profile TEXT,
    safety_profile TEXT,
    autonomy_limit TEXT,
    participant_limit INTEGER,
    delegation_depth_limit INTEGER DEFAULT 2,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS composite_capabilities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    contract_json TEXT,
    risk TEXT,
    required_authorization TEXT,
    resource_requirements TEXT,
    verification_requirements TEXT,
    rollback_requirements TEXT,
    governance_policy TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(name, organization_id, version)
);

CREATE TABLE IF NOT EXISTS capability_composition_nodes (
    id TEXT PRIMARY KEY,
    composite_id TEXT NOT NULL REFERENCES composite_capabilities(id),
    child_capability_id TEXT NOT NULL,
    role TEXT,
    required_input TEXT,
    produced_output TEXT,
    order_index INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capability_composition_edges (
    id TEXT PRIMARY KEY,
    composite_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    UNIQUE(composite_id, source_node_id, target_node_id)
);

CREATE TABLE IF NOT EXISTS engineering_teams (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    mission_id TEXT,
    project_id TEXT,
    environment TEXT,
    composite_capability_id TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'FORMING',
    governance_state TEXT,
    safety_state TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engineering_team_members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES engineering_teams(id),
    participant_id TEXT NOT NULL,
    role TEXT,
    trust_level TEXT DEFAULT 'UNKNOWN',
    capability_id TEXT,
    UNIQUE(team_id, participant_id)
);

CREATE TABLE IF NOT EXISTS delegation_requests (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    delegator_participant_id TEXT NOT NULL,
    delegate_participant_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    authorization_ref TEXT,
    policy_version TEXT,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delegation_chains (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    parent_delegation_id TEXT,
    child_delegation_id TEXT,
    depth INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delegated_tasks (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    composite_capability_id TEXT,
    parent_task_id TEXT,
    participant_id TEXT,
    role TEXT,
    capability_id TEXT,
    project_id TEXT,
    environment TEXT,
    resource_requirements TEXT,
    dependencies_json TEXT,
    authorization_ref TEXT,
    verification_requirements TEXT,
    rollback_requirements TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_contexts (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    context_data TEXT,
    fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS context_access_grants (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL REFERENCES mission_contexts(id),
    participant_id TEXT NOT NULL,
    scope TEXT,
    authorization_ref TEXT,
    state TEXT NOT NULL DEFAULT 'GRANTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_task_assignments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES delegated_tasks(id),
    participant_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ASSIGNED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_task_leases (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES collective_task_assignments(id),
    lease_expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'ACQUIRED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_handoffs (
    id TEXT PRIMARY KEY,
    from_participant_id TEXT,
    to_participant_id TEXT,
    task_id TEXT,
    artifact_ref TEXT,
    result_ref TEXT,
    provenance_ref TEXT,
    fingerprint TEXT,
    state TEXT NOT NULL DEFAULT 'TRANSFERRED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_results (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    result_data TEXT,
    confidence REAL,
    provenance_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS result_reconciliations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    result_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    quorum_used INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_confidence_records (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    confidence REAL,
    factors TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_risk_assessments (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    risk_type TEXT,
    severity TEXT,
    blast_radius REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_resource_allocations (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    amount REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'ALLOCATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_reservations (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    amount REAL NOT NULL,
    expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'RESERVED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_quarantines (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'QUARANTINED',
    quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT
);

CREATE TABLE IF NOT EXISTS collective_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS collective_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    incident_type TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collective_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    evidence_type TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_audit (
    id TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS collective_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    phase TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT,
    entity_id TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_decision_memory (
    id TEXT PRIMARY KEY,
    decision_type TEXT,
    context TEXT,
    selected_option TEXT,
    rejected_options TEXT,
    rationale TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collective_replays (
    id TEXT PRIMARY KEY,
    decision_key TEXT,
    fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;