-- Phase 62: Autonomous Production Operations & Continuous Verification Control Loop

CREATE TABLE IF NOT EXISTS operational_snapshots_phase62 (
    id TEXT PRIMARY KEY,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    provider TEXT,
    observation_key TEXT NOT NULL,
    observed_state TEXT,
    health_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    snapshot_hash TEXT NOT NULL UNIQUE,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS operational_baselines_phase62 (
    id TEXT PRIMARY KEY,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    version_release TEXT,
    expected_health TEXT NOT NULL,
    expected_state TEXT,
    baseline_metrics TEXT,
    baseline_hash TEXT NOT NULL UNIQUE,
    source TEXT,
    created_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    validity_state TEXT NOT NULL DEFAULT 'VALID'
);

CREATE TABLE IF NOT EXISTS operational_drift_phase62 (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    baseline_id TEXT,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    drift_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'LOW',
    expected_value TEXT,
    observed_value TEXT,
    drift_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'OPEN',
    detected_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_timestamp TIMESTAMP,
    FOREIGN KEY (snapshot_id) REFERENCES operational_snapshots_phase62(id),
    FOREIGN KEY (baseline_id) REFERENCES operational_baselines_phase62(id)
);

CREATE TABLE IF NOT EXISTS operational_regressions_phase62 (
    id TEXT PRIMARY KEY,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    release_ref TEXT,
    regression_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    evidence TEXT,
    baseline_ref TEXT,
    snapshot_ref TEXT,
    deterministic_fingerprint TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'OPEN',
    detected_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operational_assessments_phase62 (
    id TEXT PRIMARY KEY,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    snapshot_id TEXT,
    risk_score REAL,
    reliability_score REAL,
    security_score REAL,
    compliance_score REAL,
    deployment_score REAL,
    operational_score REAL,
    overall_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    confidence REAL,
    assessment_fingerprint TEXT NOT NULL UNIQUE,
    created_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (snapshot_id) REFERENCES operational_snapshots_phase62(id)
);

CREATE TABLE IF NOT EXISTS operational_actions_phase62 (
    id TEXT PRIMARY KEY,
    assessment_id TEXT,
    action_type TEXT NOT NULL,
    target TEXT,
    risk_level TEXT NOT NULL DEFAULT 'UNKNOWN',
    blast_radius TEXT NOT NULL DEFAULT 'UNKNOWN',
    rollback_available INTEGER NOT NULL DEFAULT 0,
    verification_required INTEGER NOT NULL DEFAULT 1,
    governance_state TEXT,
    execution_state TEXT NOT NULL DEFAULT 'PROPOSED',
    idempotency_key TEXT NOT NULL UNIQUE,
    action_fingerprint TEXT NOT NULL UNIQUE,
    created_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (assessment_id) REFERENCES operational_assessments_phase62(id)
);

CREATE TABLE IF NOT EXISTS verification_cycles_phase62 (
    id TEXT PRIMARY KEY,
    environment TEXT NOT NULL,
    service TEXT NOT NULL,
    cycle_type TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'CREATED',
    observation_id TEXT,
    assessment_id TEXT,
    action_id TEXT,
    verification_result TEXT,
    outcome TEXT,
    cycle_fingerprint TEXT NOT NULL UNIQUE,
    started_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_timestamp TIMESTAMP
);

CREATE TABLE IF NOT EXISTS verification_results_phase62 (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    action_id TEXT,
    expected_state TEXT,
    observed_state TEXT,
    verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    regression_status TEXT,
    confidence REAL,
    evidence TEXT,
    deterministic_fingerprint TEXT NOT NULL UNIQUE,
    created_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cycle_id) REFERENCES verification_cycles_phase62(id)
);

CREATE TABLE IF NOT EXISTS operational_outcomes_phase62 (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT,
    evidence TEXT,
    deterministic_fingerprint TEXT NOT NULL UNIQUE,
    created_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cycle_id) REFERENCES verification_cycles_phase62(id)
);

CREATE TABLE IF NOT EXISTS operational_control_events_phase62 (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    source TEXT,
    payload TEXT,
    correlation_id TEXT,
    event_fingerprint TEXT NOT NULL UNIQUE,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cycle_id) REFERENCES verification_cycles_phase62(id)
);

CREATE INDEX idx_phase62_snapshots_env ON operational_snapshots_phase62(environment);
CREATE INDEX idx_phase62_assessments_env ON operational_assessments_phase62(environment);
CREATE INDEX idx_phase62_cycles_env ON verification_cycles_phase62(environment);
