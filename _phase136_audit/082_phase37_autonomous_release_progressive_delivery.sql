-- Phase 37: Autonomous Release Engineering, Progressive Delivery & Production Rollout Intelligence

CREATE TABLE IF NOT EXISTS releases_phase37 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    source_revision TEXT,
    artifact_id TEXT,
    artifact_digest TEXT,
    environment_target TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','READY','APPROVAL_REQUIRED','APPROVED','SCHEDULED','IN_PROGRESS','PAUSED','PROMOTED','COMPLETED','HALTED','ROLLED_BACK','FAILED','CANCELLED')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_candidates_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    source_revision TEXT,
    artifact_id TEXT,
    artifact_digest TEXT,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_risk_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN')),
    reasons TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_impact_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    affected_services TEXT,
    affected_environments TEXT,
    blast_radius TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS rollout_plans_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS rollout_stages_phase37 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    stage_order INTEGER NOT NULL,
    target_percent REAL NOT NULL DEFAULT 0,
    health_gate_criteria TEXT,
    observation_window_seconds INTEGER NOT NULL DEFAULT 300,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES rollout_plans_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_executions_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    plan_id TEXT,
    stage_id TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED'
        CHECK (status IN ('PLANNED','APPROVAL_PENDING','APPROVED','VALIDATING','READY','EXECUTING','PAUSED','PROMOTING','COMPLETED','HALTED','ROLLED_BACK','ROLLBACK_FAILED','FAILED','CANCELLED')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id),
    FOREIGN KEY (plan_id) REFERENCES rollout_plans_phase37(id),
    FOREIGN KEY (stage_id) REFERENCES rollout_stages_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_health_gates_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    execution_id TEXT,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    availability REAL,
    error_rate REAL,
    latency_ms REAL,
    health_status TEXT,
    decision TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (decision IN ('ALLOW','PAUSE','HALT','ROLLBACK','UNKNOWN')),
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id),
    FOREIGN KEY (execution_id) REFERENCES release_executions_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_anomalies_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (severity IN ('NORMAL','WARNING','CRITICAL','UNKNOWN')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_promotions_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    promoted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id),
    FOREIGN KEY (execution_id) REFERENCES release_executions_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_rollbacks_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    verification_result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_incidents_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    resolution_state TEXT NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_evidence_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_audit_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_lineage_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    source_change TEXT,
    commit_sha TEXT,
    build_id TEXT,
    artifact_id TEXT,
    environment_id TEXT,
    service_id TEXT,
    execution_id TEXT,
    incident_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_learning_phase37 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    predicted_risk TEXT,
    actual_risk TEXT,
    outcome TEXT,
    recommendation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase37(id)
);

CREATE TABLE IF NOT EXISTS release_circuit_breakers_phase37 (
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

CREATE INDEX idx_phase37_releases_status ON releases_phase37(status);
CREATE INDEX idx_phase37_rollout_plans_release ON rollout_plans_phase37(release_id);
CREATE INDEX idx_phase37_rollout_stages_plan ON rollout_stages_phase37(plan_id);
CREATE INDEX idx_phase37_executions_release ON release_executions_phase37(release_id);
CREATE INDEX idx_phase37_health_gates_exec ON release_health_gates_phase37(execution_id);
