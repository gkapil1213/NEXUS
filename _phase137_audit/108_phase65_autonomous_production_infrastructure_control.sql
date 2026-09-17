-- Phase 65: Autonomous Production Infrastructure Integration & Real Environment Control Plane

CREATE TABLE IF NOT EXISTS provider_registry_phase65 (
    id TEXT PRIMARY KEY,
    provider_name TEXT NOT NULL UNIQUE,
    provider_type TEXT NOT NULL,
    adapter_version TEXT,
    capability_version TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    environment_scope TEXT,
    health_status TEXT NOT NULL DEFAULT 'unknown',
    last_health_check TIMESTAMP,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS environments_phase65 (
    id TEXT PRIMARY KEY,
    environment_name TEXT NOT NULL UNIQUE,
    environment_type TEXT NOT NULL,
    provider_id TEXT,
    region TEXT,
    lifecycle_status TEXT NOT NULL DEFAULT 'active',
    governance_policy_ref TEXT,
    safety_policy_ref TEXT,
    health_status TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (provider_id) REFERENCES provider_registry_phase65(id)
);

CREATE TABLE IF NOT EXISTS resources_phase65 (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    provider_resource_id TEXT,
    resource_name TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'active',
    protection_level TEXT NOT NULL DEFAULT 'STANDARD',
    capability_set TEXT,
    metadata TEXT,
    observed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider_id, provider_resource_id),
    FOREIGN KEY (provider_id) REFERENCES provider_registry_phase65(id),
    FOREIGN KEY (environment_id) REFERENCES environments_phase65(id)
);

CREATE TABLE IF NOT EXISTS change_intents_phase65 (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL UNIQUE,
    decision_id TEXT,
    environment_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    desired_state TEXT,
    rationale TEXT,
    evidence_reference TEXT,
    risk TEXT,
    confidence REAL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (environment_id) REFERENCES environments_phase65(id),
    FOREIGN KEY (resource_id) REFERENCES resources_phase65(id)
);

CREATE TABLE IF NOT EXISTS execution_plans_phase65 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL UNIQUE,
    intent_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    preconditions_json TEXT,
    governance_checks_json TEXT,
    safety_checks_json TEXT,
    execution_steps_json TEXT,
    verification_steps_json TEXT,
    rollback_plan_json TEXT,
    expected_outcome TEXT,
    blast_radius TEXT NOT NULL DEFAULT 'UNKNOWN',
    timeout_seconds INTEGER,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS provider_executions_phase65 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'PLANNED',
    provider_response TEXT,
    observed_state TEXT,
    verification_state TEXT,
    rollback_state TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS infrastructure_evidence_phase65 (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    content TEXT,
    integrity_hash TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS infrastructure_audit_phase65 (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS infrastructure_lineage_phase65 (
    id TEXT PRIMARY KEY,
    decision_id TEXT,
    intent_id TEXT NOT NULL,
    plan_id TEXT,
    execution_id TEXT,
    verification_id TEXT,
    rollback_id TEXT,
    learning_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS infrastructure_learning_phase65 (
    id TEXT PRIMARY KEY,
    operation_id TEXT,
    outcome TEXT,
    lesson TEXT,
    recommendation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase65_providers_name ON provider_registry_phase65(provider_name);
CREATE INDEX idx_phase65_resources_provider ON resources_phase65(provider_id);
CREATE INDEX idx_phase65_executions_plan ON provider_executions_phase65(plan_id);
