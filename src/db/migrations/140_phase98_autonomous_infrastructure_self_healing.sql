-- Phase 98: Autonomous Infrastructure & Self-Healing Engineering
-- Migration 140

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS infrastructure_domains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS infrastructure_providers (
    id TEXT PRIMARY KEY,
    domain_id TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'UNKNOWN',
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (domain_id) REFERENCES infrastructure_domains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_resources (
    id TEXT PRIMARY KEY,
    domain_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT,
    region TEXT,
    cluster_id TEXT,
    service_id TEXT,
    resource_type TEXT NOT NULL,
    resource_identifier TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    criticality TEXT NOT NULL DEFAULT 'UNKNOWN',
    risk_classification TEXT NOT NULL DEFAULT 'UNKNOWN',
    ownership TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (domain_id) REFERENCES infrastructure_domains(id) ON DELETE CASCADE,
    FOREIGN KEY (provider_id) REFERENCES infrastructure_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_resource_versions (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE,
    UNIQUE(resource_id, version)
);

CREATE TABLE IF NOT EXISTS infrastructure_observations (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    observation_type TEXT NOT NULL,
    value REAL,
    unit TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL DEFAULT 'system',
    provenance TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE,
    FOREIGN KEY (provider_id) REFERENCES infrastructure_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_baselines (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    baseline_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    is_stale INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE,
    UNIQUE(resource_id, version)
);

CREATE TABLE IF NOT EXISTS infrastructure_anomalies (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'NORMAL',
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    evidence TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_signals (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    value REAL,
    unit TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_incidents (
    id TEXT PRIMARY KEY,
    resource_id TEXT,
    incident_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS infrastructure_diagnoses (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    suspected_cause TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    evidence TEXT NOT NULL DEFAULT '{}',
    alternative_causes TEXT NOT NULL DEFAULT '[]',
    is_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (incident_id) REFERENCES infrastructure_incidents(id) ON DELETE CASCADE,
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_root_causes (
    id TEXT PRIMARY KEY,
    diagnosis_id TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    evidence TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (diagnosis_id) REFERENCES infrastructure_diagnoses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_impact_assessments (
    id TEXT PRIMARY KEY,
    diagnosis_id TEXT NOT NULL,
    impacted_resources TEXT NOT NULL DEFAULT '[]',
    impacted_services TEXT NOT NULL DEFAULT '[]',
    blast_radius TEXT NOT NULL DEFAULT 'UNKNOWN',
    criticality TEXT NOT NULL DEFAULT 'UNKNOWN',
    failure_domain TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (diagnosis_id) REFERENCES infrastructure_diagnoses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_risk_assessments (
    id TEXT PRIMARY KEY,
    diagnosis_id TEXT NOT NULL,
    risk_score REAL NOT NULL DEFAULT 0,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    systemic_risk INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (diagnosis_id) REFERENCES infrastructure_diagnoses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_failure_predictions (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    prediction_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    time_to_impact TEXT,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_remediation_candidates (
    id TEXT PRIMARY KEY,
    diagnosis_id TEXT NOT NULL,
    action TEXT NOT NULL,
    supported INTEGER NOT NULL DEFAULT 0,
    risk TEXT NOT NULL DEFAULT 'UNKNOWN',
    reversibility TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (diagnosis_id) REFERENCES infrastructure_diagnoses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_remediation_plans (
    id TEXT PRIMARY KEY,
    diagnosis_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'PLANNING',
    plan_data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (diagnosis_id) REFERENCES infrastructure_diagnoses(id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id) REFERENCES infrastructure_remediation_candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_remediation_steps (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    dependencies TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (plan_id) REFERENCES infrastructure_remediation_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_remediation_executions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (plan_id) REFERENCES infrastructure_remediation_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_verifications (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    evidence TEXT NOT NULL DEFAULT '{}',
    verified_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (execution_id) REFERENCES infrastructure_remediation_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_recoveries (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    recovery_plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    executed_at TEXT,
    verified_at TEXT,
    FOREIGN KEY (execution_id) REFERENCES infrastructure_remediation_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_rollbacks (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    rollback_plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    executed_at TEXT,
    verified_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (execution_id) REFERENCES infrastructure_remediation_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_checkpoints (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    checkpoint_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS infrastructure_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    half_open_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS infrastructure_quarantines (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT,
    UNIQUE(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS infrastructure_capacity (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    capacity_type TEXT NOT NULL,
    total REAL,
    available REAL,
    unit TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_resource_reservations (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    reserved_amount REAL NOT NULL,
    reservation_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_change_windows (
    id TEXT PRIMARY KEY,
    window_type TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    is_freeze INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS infrastructure_maintenance_windows (
    id TEXT PRIMARY KEY,
    change_window_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'SCHEDULED',
    FOREIGN KEY (change_window_id) REFERENCES infrastructure_change_windows(id) ON DELETE CASCADE,
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS infrastructure_audit (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    actor TEXT NOT NULL,
    reason TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS infrastructure_lineage (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    node_id TEXT NOT NULL,
    parent_node_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS infrastructure_learning (
    id TEXT PRIMARY KEY,
    resource_id TEXT,
    learning_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS infrastructure_replay (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    divergence INTEGER NOT NULL DEFAULT 0,
    replayed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES infrastructure_resources(id) ON DELETE CASCADE
);

CREATE INDEX idx_resources_domain ON infrastructure_resources(domain_id);
CREATE INDEX idx_resources_provider ON infrastructure_resources(provider_id);
CREATE INDEX idx_observations_resource ON infrastructure_observations(resource_id);
CREATE INDEX idx_anomalies_resource ON infrastructure_anomalies(resource_id);
CREATE INDEX idx_incidents_resource ON infrastructure_incidents(resource_id);
CREATE INDEX idx_diagnoses_incident ON infrastructure_diagnoses(incident_id);
