-- Phase 36: Autonomous Release Engineering, Progressive Delivery & Production Change Control

CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    source_revision TEXT,
    artifact_refs TEXT,
    pipeline_id TEXT,
    environment_target TEXT,
    classification TEXT NOT NULL DEFAULT 'UNKNOWN',
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','READY','APPROVAL_REQUIRED','APPROVED','SCHEDULED','IN_PROGRESS','PAUSED','PROMOTED','COMPLETED','HALTED','ROLLED_BACK','FAILED','CANCELLED')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id)
);

CREATE TABLE IF NOT EXISTS release_candidates (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    source_revision TEXT,
    changed_files TEXT,
    affected_services TEXT,
    pipeline_health TEXT,
    build_health TEXT,
    test_health TEXT,
    flaky_tests INTEGER DEFAULT 0,
    dependency_impact TEXT,
    historical_failures INTEGER DEFAULT 0,
    rollback_rate REAL,
    deployment_frequency REAL,
    change_size TEXT,
    change_criticality TEXT,
    affected_environments TEXT,
    affected_resources TEXT,
    security_findings TEXT,
    infrastructure_risk TEXT,
    data_layer_risk TEXT,
    runtime_risk TEXT,
    analysis_json TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_risk_assessments (
    id TEXT PRIMARY KEY,
    release_candidate_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN')),
    risk_reasons TEXT,
    confidence REAL,
    recommended_strategy TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_candidate_id) REFERENCES release_candidates(id)
);

CREATE TABLE IF NOT EXISTS release_health (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    app_health TEXT,
    service_health TEXT,
    error_rate REAL,
    latency_ms REAL,
    availability REAL,
    slo_status TEXT,
    incident_activity INTEGER,
    dependency_health TEXT,
    infrastructure_health TEXT,
    resource_saturation REAL,
    rollback_signal INTEGER,
    anomaly_signal INTEGER,
    security_signal INTEGER,
    health TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (health IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN')),
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS progressive_delivery_plans (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    provider TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_rollout_waves (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    wave_order INTEGER NOT NULL,
    target_env TEXT,
    target_resources TEXT,
    traffic_percent REAL,
    health_gate TEXT,
    min_observation_window INTEGER,
    promotion_condition TEXT,
    halt_condition TEXT,
    rollback_condition TEXT,
    approval_required INTEGER DEFAULT 0,
    risk_level TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES progressive_delivery_plans(id)
);

CREATE TABLE IF NOT EXISTS release_promotion_decisions (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    wave_id TEXT,
    decision TEXT NOT NULL
        CHECK (decision IN ('PROMOTE','HOLD','HALT','ROLLBACK','ESCALATE')),
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id),
    FOREIGN KEY (wave_id) REFERENCES release_rollout_waves(id)
);

CREATE TABLE IF NOT EXISTS release_halt_decisions (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_executions (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED','QUEUED','RUNNING','PAUSED','HALTED','SUCCEEDED','FAILED','ROLLED_BACK','CANCELLED')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_rollbacks (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    verification_result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_governance_decisions (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    decision TEXT NOT NULL
        CHECK (decision IN ('ALLOW','REQUIRE_APPROVAL','DENY','FREEZE')),
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_safety_decisions (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    safe INTEGER NOT NULL DEFAULT 1,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_incidents (
    id TEXT PRIMARY KEY,
    release_id TEXT,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL,
    escalation_status TEXT,
    resolution_state TEXT NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_evidence (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    operation_id TEXT,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_audit_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    decision TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS release_lineage (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    source_change TEXT,
    commit_sha TEXT,
    pipeline_id TEXT,
    build_id TEXT,
    test_run_id TEXT,
    artifact_id TEXT,
    rollout_plan_id TEXT,
    wave_id TEXT,
    execution_id TEXT,
    incident_id TEXT,
    evidence_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_learning (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    predicted_risk TEXT,
    actual_risk TEXT,
    predicted_health TEXT,
    actual_health TEXT,
    strategy TEXT,
    outcome TEXT,
    failure_reason TEXT,
    improvement_signal TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases(id)
);

CREATE TABLE IF NOT EXISTS release_circuit_breakers (
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

CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
CREATE INDEX IF NOT EXISTS idx_release_candidates_release ON release_candidates(release_id);
CREATE INDEX IF NOT EXISTS idx_release_risk_candidate ON release_risk_assessments(release_candidate_id);
CREATE INDEX IF NOT EXISTS idx_release_health_release ON release_health(release_id);
CREATE INDEX IF NOT EXISTS idx_progressive_plans_release ON progressive_delivery_plans(release_id);
CREATE INDEX IF NOT EXISTS idx_rollout_waves_plan ON release_rollout_waves(plan_id);
CREATE INDEX IF NOT EXISTS idx_release_executions_release ON release_executions(release_id);
CREATE INDEX IF NOT EXISTS idx_release_incidents_release ON release_incidents(release_id);
