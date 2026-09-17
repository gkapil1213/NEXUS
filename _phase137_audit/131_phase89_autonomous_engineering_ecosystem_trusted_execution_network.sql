-- Phase 89: Autonomous Engineering Ecosystem & Trusted Execution Network
BEGIN;

CREATE TABLE IF NOT EXISTS engineering_ecosystems (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE',
    governance_profile TEXT,
    safety_profile TEXT,
    trust_policy TEXT,
    autonomy_policy TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS federation_domains (
    id TEXT PRIMARY KEY,
    ecosystem_id TEXT NOT NULL REFERENCES engineering_ecosystems(id),
    name TEXT NOT NULL,
    trust_domain TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(ecosystem_id, name)
);

CREATE TABLE IF NOT EXISTS engineering_agents (
    id TEXT PRIMARY KEY,
    ecosystem_id TEXT NOT NULL REFERENCES engineering_ecosystems(id),
    organization_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    owner TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    identity_version INTEGER NOT NULL DEFAULT 1,
    auth_metadata_ref TEXT,
    authorization_scope TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capability_versions (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL REFERENCES capabilities(id),
    version INTEGER NOT NULL,
    input_contract TEXT,
    output_contract TEXT,
    risk_classification TEXT,
    required_permissions TEXT,
    required_resources TEXT,
    supported_environments TEXT,
    supported_projects TEXT,
    verification_requirements TEXT,
    rollback_requirements TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(capability_id, version)
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES engineering_agents(id),
    capability_id TEXT NOT NULL REFERENCES capabilities(id),
    capability_version INTEGER,
    attestation_ref TEXT,
    trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_id, capability_id)
);

CREATE TABLE IF NOT EXISTS execution_providers (
    id TEXT PRIMARY KEY,
    ecosystem_id TEXT NOT NULL REFERENCES engineering_ecosystems(id),
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider_type TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_workers (
    id TEXT PRIMARY KEY,
    provider_id TEXT REFERENCES execution_providers(id),
    ecosystem_id TEXT NOT NULL REFERENCES engineering_ecosystems(id),
    region_id TEXT,
    capabilities TEXT,
    capacity REAL,
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    environment_permissions TEXT,
    project_permissions TEXT,
    concurrency INT,
    trust_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capability_grants (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    provider_id TEXT,
    worker_id TEXT,
    capability_id TEXT,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT,
    operation TEXT,
    policy_version TEXT,
    validity_start TEXT,
    validity_end TEXT,
    state TEXT NOT NULL DEFAULT 'GRANTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capability_revocations (
    id TEXT PRIMARY KEY,
    grant_id TEXT,
    capability_id TEXT,
    entity_type TEXT,
    entity_id TEXT,
    reason TEXT,
    revoked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_contracts (
    id TEXT PRIMARY KEY,
    workload_id TEXT,
    capability_id TEXT,
    project_id TEXT,
    environment TEXT,
    resource_requirements TEXT,
    risk_classification TEXT,
    rollback_plan TEXT,
    verification_plan TEXT,
    deadline TEXT,
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_assignments (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES execution_contracts(id),
    agent_id TEXT,
    provider_id TEXT,
    worker_id TEXT,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_leases (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES task_assignments(id),
    lease_expires_at TEXT,
    state TEXT NOT NULL DEFAULT 'ACQUIRED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS federated_dispatches (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES task_assignments(id),
    state TEXT NOT NULL DEFAULT 'DISPATCHED',
    dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_provenance (
    id TEXT PRIMARY KEY,
    dispatch_id TEXT,
    agent_id TEXT,
    provider_id TEXT,
    worker_id TEXT,
    capability_version TEXT,
    authorization_version TEXT,
    policy_version TEXT,
    input_fingerprint TEXT,
    output_fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_result_verifications (
    id TEXT PRIMARY KEY,
    dispatch_id TEXT,
    result TEXT NOT NULL DEFAULT 'UNKNOWN',
    verified_at TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_reputation (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    verification_success_count INTEGER DEFAULT 0,
    regression_count INTEGER DEFAULT 0,
    policy_violation_count INTEGER DEFAULT 0,
    reputation_score REAL DEFAULT 0.5,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_reputation (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    availability REAL DEFAULT 1.0,
    reliability_score REAL DEFAULT 0.5,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_quarantines (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'QUARANTINED',
    quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT
);

CREATE TABLE IF NOT EXISTS provider_quarantines (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'QUARANTINED',
    quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT
);

CREATE TABLE IF NOT EXISTS capability_quarantines (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'QUARANTINED',
    quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT
);

CREATE TABLE IF NOT EXISTS federation_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS trust_events (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    trust_level_before TEXT,
    trust_level_after TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS federation_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    incident_type TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS federation_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    evidence_type TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS federation_audit (
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

CREATE TABLE IF NOT EXISTS federation_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    phase TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS federation_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT,
    entity_id TEXT,
    data TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS federation_replays (
    id TEXT PRIMARY KEY,
    decision_key TEXT,
    fingerprint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;