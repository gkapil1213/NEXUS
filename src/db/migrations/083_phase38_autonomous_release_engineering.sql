-- Phase 38: Autonomous Release Engineering, Progressive Delivery & Production Change Control

CREATE TABLE IF NOT EXISTS releases_phase38 (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    application_id TEXT,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    commit_sha TEXT,
    artifact_id TEXT,
    source_environment TEXT,
    target_environment TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','READY','APPROVAL_REQUIRED','APPROVED','BLOCKED','SCHEDULED','EXECUTING','PAUSED','SUCCEEDED','FAILED','ROLLED_BACK','CANCELLED')),
    risk TEXT NOT NULL DEFAULT 'UNKNOWN',
    strategy TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_candidates_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    source_revision TEXT,
    artifact_id TEXT,
    artifact_digest TEXT,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS artifact_provenance_phase38 (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    digest TEXT,
    build_id TEXT,
    commit_sha TEXT,
    repository TEXT,
    pipeline TEXT,
    builder TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    provenance_metadata TEXT,
    security_findings TEXT,
    dependency_metadata TEXT
);

CREATE TABLE IF NOT EXISTS release_strategies_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS rollout_plans_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    target_environment TEXT,
    waves_json TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS rollout_waves_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    percentage REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','READY','EXECUTING','PAUSED','SUCCEEDED','FAILED','HALTED','ROLLED_BACK')),
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id),
    FOREIGN KEY (plan_id) REFERENCES rollout_plans_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_health_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    error_rate REAL,
    latency_ms REAL,
    availability REAL,
    request_failure_rate REAL,
    resource_saturation REAL,
    crash_rate REAL,
    restart_rate REAL,
    slo_state TEXT,
    incident_state TEXT,
    security_state TEXT,
    dependency_health TEXT,
    health TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (health IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN')),
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_risk_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN')),
    reasons TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_impact_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    impact_score REAL,
    blast_radius TEXT NOT NULL DEFAULT 'UNKNOWN',
    affected_services TEXT,
    affected_applications TEXT,
    affected_environments TEXT,
    affected_databases TEXT,
    affected_infrastructure TEXT,
    affected_dependencies TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_approvals_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    approver TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','APPROVED','DENIED','EXPIRED','REVOKED')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_executions_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    wave_id TEXT,
    provider TEXT,
    environment TEXT,
    operation TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','APPROVED','RUNNING','PAUSED','SUCCEEDED','FAILED','HALTED','ROLLED_BACK')),
    attempt INTEGER DEFAULT 1,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id),
    FOREIGN KEY (wave_id) REFERENCES rollout_waves_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_halt_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'HALTED',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_rollbacks_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    verification_result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_circuit_breakers_phase38 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED'
        CHECK (state IN ('CLOSED','OPEN','HALF_OPEN')),
    opened_at TIMESTAMP,
    cooldown_until TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_incidents_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    resolution_state TEXT NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_escalations_phase38 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES release_incidents_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_evidence_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_audit_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_lineage_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    source_change TEXT,
    commit_sha TEXT,
    build_id TEXT,
    artifact_id TEXT,
    environment_id TEXT,
    execution_id TEXT,
    incident_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE TABLE IF NOT EXISTS release_learning_phase38 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    predicted_risk TEXT,
    actual_risk TEXT,
    outcome TEXT,
    recommendation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase38(id)
);

CREATE INDEX idx_phase38_releases_status ON releases_phase38(status);
CREATE INDEX idx_phase38_rollout_waves_release ON rollout_waves_phase38(release_id);
CREATE INDEX idx_phase38_executions_release ON release_executions_phase38(release_id);
CREATE INDEX idx_phase38_incidents_release ON release_incidents_phase38(release_id);
