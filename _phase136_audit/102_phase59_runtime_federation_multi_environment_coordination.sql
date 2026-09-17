-- Phase 59: Autonomous Engineering Runtime Federation, Multi-Environment Control & Global Execution Coordination

CREATE TABLE IF NOT EXISTS environments_phase59 (
    id TEXT PRIMARY KEY,
    environment_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    environment_type TEXT NOT NULL,
    provider TEXT,
    region TEXT,
    account_identifier TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'active',
    health_state TEXT NOT NULL DEFAULT 'unknown',
    trust_level TEXT NOT NULL DEFAULT 'low',
    criticality TEXT NOT NULL DEFAULT 'low',
    config_fingerprint TEXT,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS environment_capabilities_phase59 (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(environment_id, capability),
    FOREIGN KEY (environment_id) REFERENCES environments_phase59(id)
);

CREATE TABLE IF NOT EXISTS environment_dependencies_phase59 (
    id TEXT PRIMARY KEY,
    source_env_id TEXT NOT NULL,
    target_env_id TEXT NOT NULL,
    relationship TEXT NOT NULL DEFAULT 'depends_on',
    UNIQUE(source_env_id, target_env_id),
    FOREIGN KEY (source_env_id) REFERENCES environments_phase59(id),
    FOREIGN KEY (target_env_id) REFERENCES environments_phase59(id)
);

CREATE TABLE IF NOT EXISTS runtime_agents_phase59 (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL UNIQUE,
    environment_id TEXT NOT NULL,
    provider TEXT,
    capabilities TEXT,
    health_state TEXT NOT NULL DEFAULT 'unknown',
    availability TEXT NOT NULL DEFAULT 'unknown',
    trust TEXT NOT NULL DEFAULT 'low',
    version TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    lease_expiry TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (environment_id) REFERENCES environments_phase59(id)
);

CREATE TABLE IF NOT EXISTS execution_leases_phase59 (
    id TEXT PRIMARY KEY,
    lease_token TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    renewed_at TIMESTAMP,
    released_at TIMESTAMP,
    UNIQUE(operation_id)
);

CREATE TABLE IF NOT EXISTS federation_operations_phase59 (
    id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL,
    source_environment TEXT NOT NULL,
    target_environment TEXT,
    operation_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CREATED',
    governance_state TEXT,
    safety_state TEXT,
    execution_state TEXT,
    verification_state TEXT,
    rollback_state TEXT,
    priority INTEGER DEFAULT 0,
    risk TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS federation_steps_phase59 (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    environment_id TEXT NOT NULL,
    action TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    verification_state TEXT,
    FOREIGN KEY (operation_id) REFERENCES federation_operations_phase59(id),
    FOREIGN KEY (environment_id) REFERENCES environments_phase59(id)
);

CREATE TABLE IF NOT EXISTS promotion_records_phase59 (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    source_environment TEXT NOT NULL,
    target_environment TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    approval_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS federation_incidents_phase59 (
    id TEXT PRIMARY KEY,
    operation_id TEXT,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS federation_evidence_phase59 (
    id TEXT PRIMARY KEY,
    operation_id TEXT,
    evidence_type TEXT NOT NULL,
    evidence TEXT,
    integrity_hash TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS federation_audit_phase59 (
    id TEXT PRIMARY KEY,
    operation_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS federation_lineage_phase59 (
    id TEXT PRIMARY KEY,
    objective_id TEXT,
    operation_id TEXT,
    environment_id TEXT,
    agent_id TEXT,
    execution_id TEXT,
    verification_id TEXT,
    rollback_id TEXT,
    learning_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS federation_learning_phase59 (
    id TEXT PRIMARY KEY,
    operation_id TEXT,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase59_env_key ON environments_phase59(environment_key);
CREATE INDEX idx_phase59_ops_state ON federation_operations_phase59(state);
CREATE INDEX idx_phase59_promos_artifact ON promotion_records_phase59(artifact_id);
