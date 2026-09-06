-- Phase 39: Autonomous Release Engineering, Progressive Delivery & Production Change Control

CREATE TABLE IF NOT EXISTS releases_phase39 (
    id TEXT PRIMARY KEY,
    application_id TEXT,
    service_id TEXT,
    environment TEXT,
    version TEXT NOT NULL,
    source_revision TEXT,
    artifact_id TEXT,
    artifact_fingerprint TEXT,
    release_type TEXT NOT NULL CHECK (release_type IN ('standard','hotfix','rollback','emergency')),
    strategy TEXT,
    state TEXT NOT NULL DEFAULT 'candidate'
        CHECK (state IN ('candidate','approved','rejected','cancelled','released','failed','rolled_back','halted')),
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    failure_info TEXT,
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS release_candidates_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    source_revision TEXT,
    artifact_id TEXT,
    artifact_digest TEXT,
    test_status TEXT,
    security_status TEXT,
    dependency_status TEXT,
    environment_compatibility TEXT,
    approval_status TEXT NOT NULL DEFAULT 'PENDING',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS artifact_provenance_phase39 (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    digest TEXT,
    source_commit TEXT,
    build_id TEXT,
    pipeline TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    provenance_metadata TEXT,
    UNIQUE(artifact_id, digest)
);

CREATE TABLE IF NOT EXISTS version_consistency_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    application_id TEXT,
    expected_version TEXT,
    artifact_version TEXT,
    target_version TEXT,
    consistent INTEGER NOT NULL DEFAULT 0,
    details TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS deployment_strategies_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    strategy TEXT NOT NULL CHECK (strategy IN ('rolling','canary','blue-green','recreate')),
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS progressive_rollouts_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned'
        CHECK (state IN ('planned','running','paused','halted','completed','failed','rolled_back')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS rollout_waves_phase39 (
    id TEXT PRIMARY KEY,
    rollout_id TEXT NOT NULL,
    wave_number INTEGER NOT NULL,
    target_scope TEXT,
    percentage REAL NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','ready','executing','paused','succeeded','failed','halted','rolled_back')),
    start_time TIMESTAMP,
    completion_time TIMESTAMP,
    health_result TEXT,
    risk_result TEXT,
    decision TEXT,
    execution_ref TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (rollout_id) REFERENCES progressive_rollouts_phase39(id)
);

CREATE TABLE IF NOT EXISTS canary_analysis_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    error_rate REAL,
    latency_ms REAL,
    availability REAL,
    throughput REAL,
    saturation REAL,
    crash_rate REAL,
    health_state TEXT,
    slo_state TEXT,
    outcome TEXT NOT NULL DEFAULT 'unknown'
        CHECK (outcome IN ('healthy','degraded','unhealthy','unknown')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_health_gates_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    evaluation_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    app_health TEXT,
    infra_health TEXT,
    deployment_health TEXT,
    error_rate_health TEXT,
    latency_health TEXT,
    slo_health TEXT,
    dependency_health TEXT,
    canary_health TEXT,
    decision TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (decision IN ('ALLOW','PAUSE','HALT','ROLLBACK','UNKNOWN')),
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_risk_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN')),
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_impact_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    affected_services TEXT,
    affected_environments TEXT,
    dependent_systems TEXT,
    downstream_consumers TEXT,
    data_impact TEXT,
    infrastructure_impact TEXT,
    user_impact TEXT,
    operational_impact TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_blast_radius_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    resource_count INTEGER DEFAULT 0,
    environment_count INTEGER DEFAULT 0,
    service_count INTEGER DEFAULT 0,
    dependency_depth INTEGER DEFAULT 0,
    critical_resources INTEGER DEFAULT 0,
    customer_facing INTEGER DEFAULT 0,
    classification TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_governance_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('ALLOW','APPROVAL_REQUIRED','DENY','FREEZE')),
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_approvals_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    approver TEXT,
    decision TEXT NOT NULL DEFAULT 'PENDING',
    reason TEXT,
    approved_at TIMESTAMP,
    expires_at TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_safety_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    safe INTEGER NOT NULL DEFAULT 1,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_executions_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    environment TEXT,
    state TEXT NOT NULL DEFAULT 'created'
        CHECK (state IN ('created','approved','running','paused','halted','succeeded','failed','rolling_back','rolled_back')),
    strategy TEXT,
    wave_id TEXT,
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id),
    FOREIGN KEY (wave_id) REFERENCES rollout_waves_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_pause_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_halt_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_rollbacks_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    target_version TEXT,
    reason TEXT,
    execution_id TEXT,
    result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_incidents_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    environment TEXT,
    severity TEXT NOT NULL,
    trigger TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    impact TEXT,
    mitigation TEXT,
    resolution TEXT,
    signature TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_escalations_phase39 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES release_incidents_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_evidence_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_audit_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_lineage_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    source_commit TEXT,
    build_id TEXT,
    artifact_id TEXT,
    candidate_id TEXT,
    rollout_id TEXT,
    wave_id TEXT,
    execution_id TEXT,
    incident_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_learning_phase39 (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    outcome TEXT,
    recommendation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (release_id) REFERENCES releases_phase39(id)
);

CREATE TABLE IF NOT EXISTS release_circuit_breakers_phase39 (
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

CREATE INDEX idx_phase39_releases_state ON releases_phase39(state);
CREATE INDEX idx_phase39_rollout_waves_rollout ON rollout_waves_phase39(rollout_id);
CREATE INDEX idx_phase39_executions_release ON release_executions_phase39(release_id);
CREATE INDEX idx_phase39_incidents_release ON release_incidents_phase39(release_id);
