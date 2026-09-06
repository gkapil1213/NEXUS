-- Phase 35: Autonomous CI/CD Pipeline Intelligence & Delivery Operations

CREATE TABLE IF NOT EXISTS cicd_pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repository_id TEXT,
    branch TEXT,
    environment_id TEXT,
    provider TEXT NOT NULL,
    external_id TEXT,
    owner TEXT,
    status TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (status IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN','BLOCKED')),
    config_fingerprint TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider, external_id)
);

CREATE TABLE IF NOT EXISTS cicd_pipeline_observations (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success_rate REAL,
    failure_rate REAL,
    avg_duration_ms INTEGER,
    queue_time_ms INTEGER,
    timeout_rate REAL,
    cancellation_rate REAL,
    recent_failures INTEGER DEFAULT 0,
    recent_recovery INTEGER DEFAULT 0,
    availability REAL,
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    raw_data TEXT,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id)
);

CREATE TABLE IF NOT EXISTS cicd_builds (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    commit_sha TEXT,
    branch TEXT,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    queue_time_ms INTEGER,
    artifact_id TEXT,
    test_result_id TEXT,
    provider TEXT,
    external_id TEXT,
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id)
);

CREATE TABLE IF NOT EXISTS cicd_test_runs (
    id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL,
    suite_name TEXT,
    pass_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    skip_count INTEGER DEFAULT 0,
    duration_ms INTEGER,
    failure_signature TEXT,
    flaky_score REAL DEFAULT 0,
    classification TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (classification IN ('REAL_FAILURE','FLAKY_FAILURE','INFRASTRUCTURE_FAILURE','TIMEOUT','CANCELLATION','UNKNOWN')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (build_id) REFERENCES cicd_builds(id)
);

CREATE TABLE IF NOT EXISTS cicd_pipeline_findings (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    details TEXT,
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id)
);

CREATE TABLE IF NOT EXISTS cicd_pipeline_dependencies (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relationship TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_type, source_id, target_type, target_id, relationship)
);

CREATE TABLE IF NOT EXISTS cicd_change_correlations (
    id TEXT PRIMARY KEY,
    change_ref TEXT NOT NULL,
    change_type TEXT NOT NULL,
    pipeline_id TEXT,
    build_id TEXT,
    test_run_id TEXT,
    artifact_id TEXT,
    release_id TEXT,
    deployment_id TEXT,
    incident_id TEXT,
    correlation TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (correlation IN ('CORRELATED','LIKELY_CORRELATED','NO_CORRELATION','UNKNOWN')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id),
    FOREIGN KEY (build_id) REFERENCES cicd_builds(id)
);

CREATE TABLE IF NOT EXISTS cicd_delivery_risks (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    assessment_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL','UNKNOWN')),
    inputs TEXT,
    factors TEXT,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id)
);

CREATE TABLE IF NOT EXISTS cicd_delivery_impacts (
    id TEXT PRIMARY KEY,
    risk_id TEXT,
    pipeline_id TEXT NOT NULL,
    affected_repositories TEXT,
    affected_artifacts TEXT,
    affected_environments TEXT,
    affected_services TEXT,
    blast_radius TEXT,
    analyzed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id),
    FOREIGN KEY (risk_id) REFERENCES cicd_delivery_risks(id)
);

CREATE TABLE IF NOT EXISTS cicd_execution_plans (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PLANNED'
        CHECK (status IN ('PLANNED','APPROVAL_REQUIRED','APPROVED','RUNNING','VERIFYING','SUCCEEDED','FAILED','HALTED','ROLLED_BACK','CANCELLED')),
    idempotency_key TEXT NOT NULL UNIQUE,
    governance_decision TEXT,
    safety_decision TEXT,
    risk_level TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id)
);

CREATE TABLE IF NOT EXISTS cicd_remediations (
    id TEXT PRIMARY KEY,
    execution_plan_id TEXT,
    pipeline_id TEXT NOT NULL,
    category TEXT NOT NULL,
    plan TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    verification_result TEXT
        CHECK (verification_result IN ('SUCCESS','PARTIAL_SUCCESS','FAILED','UNKNOWN')),
    rollback_status TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id),
    FOREIGN KEY (execution_plan_id) REFERENCES cicd_execution_plans(id)
);

CREATE TABLE IF NOT EXISTS cicd_circuit_breakers (
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

CREATE TABLE IF NOT EXISTS cicd_incidents (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT,
    build_id TEXT,
    repository_id TEXT,
    environment_id TEXT,
    failure_signature TEXT,
    severity TEXT NOT NULL,
    impact TEXT,
    correlation_id TEXT,
    remediation_id TEXT,
    escalation_status TEXT,
    resolution_state TEXT NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pipeline_id) REFERENCES cicd_pipelines(id),
    FOREIGN KEY (build_id) REFERENCES cicd_builds(id)
);

CREATE TABLE IF NOT EXISTS cicd_learning_outcomes (
    id TEXT PRIMARY KEY,
    incident_id TEXT,
    failure_pattern TEXT,
    remediation_attempted TEXT,
    remediation_result TEXT,
    rollback_result TEXT,
    provider_behavior TEXT,
    verification_outcome TEXT,
    policy_decision TEXT,
    recommendation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES cicd_incidents(id)
);

CREATE INDEX IF NOT EXISTS idx_cicd_pipelines_provider ON cicd_pipelines(provider);
CREATE INDEX IF NOT EXISTS idx_cicd_builds_pipeline ON cicd_builds(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_cicd_test_runs_build ON cicd_test_runs(build_id);
CREATE INDEX IF NOT EXISTS idx_cicd_findings_pipeline ON cicd_pipeline_findings(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_cicd_execution_plans_pipeline ON cicd_execution_plans(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_cicd_incidents_pipeline ON cicd_incidents(pipeline_id);
