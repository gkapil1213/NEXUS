-- Phase 48: Autonomous Disaster Recovery, Business Continuity & Resilience Intelligence

CREATE TABLE IF NOT EXISTS recovery_assets_phase48 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    environment TEXT,
    asset_type TEXT NOT NULL,
    owner TEXT,
    criticality TEXT NOT NULL DEFAULT 'unknown',
    recovery_capability TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recovery_dependencies_phase48 (
    id TEXT PRIMARY KEY,
    source_asset_id TEXT NOT NULL,
    target_asset_id TEXT NOT NULL,
    relationship TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_asset_id, target_asset_id),
    FOREIGN KEY (source_asset_id) REFERENCES recovery_assets_phase48(id),
    FOREIGN KEY (target_asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE TABLE IF NOT EXISTS backup_inventories_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    backup_id TEXT NOT NULL,
    backup_type TEXT,
    target_location TEXT,
    created_time TIMESTAMP,
    expiration TIMESTAMP,
    retention TEXT,
    provider TEXT,
    integrity_state TEXT NOT NULL DEFAULT 'unknown',
    freshness_state TEXT NOT NULL DEFAULT 'unknown',
    recoverability TEXT,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE TABLE IF NOT EXISTS backup_observations_phase48 (
    id TEXT PRIMARY KEY,
    backup_id TEXT NOT NULL,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT,
    size_bytes REAL,
    integrity_result TEXT,
    freshness_seconds INTEGER,
    FOREIGN KEY (backup_id) REFERENCES backup_inventories_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_objectives_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    rpo_target_seconds INTEGER,
    rto_target_seconds INTEGER,
    rpo_compliance TEXT NOT NULL DEFAULT 'unknown',
    rto_compliance TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_readiness_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    readiness_state TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_scenarios_phase48 (
    id TEXT PRIMARY KEY,
    scenario_type TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recovery_plans_phase48 (
    id TEXT PRIMARY KEY,
    scenario_id TEXT,
    objectives TEXT,
    target_services TEXT,
    dependency_order TEXT,
    steps_json TEXT,
    approval_required INTEGER DEFAULT 0,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scenario_id) REFERENCES recovery_scenarios_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_executions_phase48 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'created',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES recovery_plans_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_steps_phase48 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    action TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase48(id)
);

CREATE TABLE IF NOT EXISTS restore_operations_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    source TEXT,
    destination TEXT,
    provider TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    verification_status TEXT,
    error TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE TABLE IF NOT EXISTS failover_operations_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    source_environment TEXT,
    target_environment TEXT,
    provider TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    verification_status TEXT,
    error TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_verifications_phase48 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_type TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_regressions_phase48 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    regression_type TEXT NOT NULL,
    detected INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_rollbacks_phase48 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_circuit_breakers_phase48 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recovery_incidents_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    execution_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id),
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_escalations_phase48 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES recovery_incidents_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_evidence_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT,
    execution_id TEXT,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id),
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_audit_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_lineage_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    scenario_id TEXT,
    plan_id TEXT,
    execution_id TEXT,
    step_id TEXT,
    restore_id TEXT,
    failover_id TEXT,
    verification_id TEXT,
    rollback_id TEXT,
    incident_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE TABLE IF NOT EXISTS recovery_learning_phase48 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES recovery_assets_phase48(id)
);

CREATE INDEX idx_phase48_assets_provider ON recovery_assets_phase48(provider);
CREATE INDEX idx_phase48_backups_asset ON backup_inventories_phase48(asset_id);
CREATE INDEX idx_phase48_executions_plan ON recovery_executions_phase48(plan_id);
CREATE INDEX idx_phase48_incidents_asset ON recovery_incidents_phase48(asset_id);
