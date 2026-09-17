-- Phase 45: Autonomous Disaster Recovery, Business Continuity & Resilience Intelligence

CREATE TABLE IF NOT EXISTS resilience_services_phase45 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    criticality TEXT NOT NULL DEFAULT 'unknown',
    owner TEXT,
    recovery_priority INTEGER DEFAULT 0,
    recovery_strategy TEXT,
    rto_target INTEGER,
    rpo_target INTEGER,
    resilience_status TEXT NOT NULL DEFAULT 'unknown',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resilience_dependencies_phase45 (
    id TEXT PRIMARY KEY,
    source_service_id TEXT NOT NULL,
    target_service_id TEXT NOT NULL,
    relationship TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_service_id, target_service_id),
    FOREIGN KEY (source_service_id) REFERENCES resilience_services_phase45(id),
    FOREIGN KEY (target_service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS failure_impacts_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    failure_type TEXT NOT NULL,
    affected_services TEXT,
    blast_radius TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_objectives_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    rto_target INTEGER,
    rpo_target INTEGER,
    observed_rto INTEGER,
    observed_rpo INTEGER,
    compliance_state TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS backup_observations_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    backup_id TEXT,
    backup_age_seconds INTEGER,
    backup_status TEXT,
    integrity_state TEXT,
    restore_point_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS restore_readiness_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    readiness_state TEXT NOT NULL DEFAULT 'unknown',
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_strategies_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    provider_capability_required TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_plans_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    failure_id TEXT,
    strategy TEXT,
    dependency_order TEXT,
    actions_json TEXT,
    approval_required INTEGER DEFAULT 0,
    safety_conditions TEXT,
    expected_outcome TEXT,
    rto_target INTEGER,
    rpo_target INTEGER,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_executions_phase45 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES recovery_plans_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_verifications_phase45 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'unknown',
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_rollbacks_phase45 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_circuit_breakers_phase45 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recovery_incidents_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_escalations_phase45 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES recovery_incidents_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_evidence_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_audit_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_lineage_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    failure_id TEXT,
    impact_id TEXT,
    plan_id TEXT,
    execution_id TEXT,
    rollback_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE TABLE IF NOT EXISTS recovery_learning_phase45 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES resilience_services_phase45(id)
);

CREATE INDEX idx_phase45_services_criticality ON resilience_services_phase45(criticality);
CREATE INDEX idx_phase45_dependencies_source ON resilience_dependencies_phase45(source_service_id);
CREATE INDEX idx_phase45_executions_plan ON recovery_executions_phase45(plan_id);
