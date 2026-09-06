-- Phase 42: Autonomous Security Operations & SecOps Intelligence

CREATE TABLE IF NOT EXISTS security_assets_phase42 (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    external_id TEXT,
    asset_type TEXT NOT NULL,
    environment TEXT,
    service_id TEXT,
    owner TEXT,
    criticality TEXT NOT NULL DEFAULT 'unknown'
        CHECK (criticality IN ('low','medium','high','critical','unknown')),
    classification TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS security_posture_phase42 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    posture_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (posture_state IN ('secure','at_risk','compromised','unknown')),
    security_score REAL,
    exposure_level TEXT,
    control_status TEXT,
    observation_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT,
    FOREIGN KEY (asset_id) REFERENCES security_assets_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_vulnerabilities_phase42 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    vulnerability_id TEXT NOT NULL,
    source TEXT,
    severity TEXT NOT NULL,
    exploitability TEXT,
    affected_component TEXT,
    discovered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    state TEXT NOT NULL DEFAULT 'discovered',
    remediation_status TEXT,
    metadata TEXT,
    UNIQUE(asset_id, vulnerability_id),
    FOREIGN KEY (asset_id) REFERENCES security_assets_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_findings_phase42 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    finding_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence REAL DEFAULT 0,
    evidence TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES security_assets_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_signals_phase42 (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    provider TEXT,
    signal_type TEXT NOT NULL,
    asset_id TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    severity TEXT,
    confidence REAL,
    fingerprint TEXT NOT NULL UNIQUE,
    payload_metadata TEXT,
    FOREIGN KEY (asset_id) REFERENCES security_assets_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_anomalies_phase42 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    severity TEXT,
    confidence REAL,
    baseline TEXT,
    observed_value TEXT,
    expected_value TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES security_assets_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_correlations_phase42 (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    correlation_strength TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS security_risk_assessments_phase42 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    risk_score REAL,
    severity TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL,
    exploitability TEXT,
    asset_criticality TEXT,
    exposure TEXT,
    impact TEXT,
    blast_radius TEXT,
    rationale TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES security_assets_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_incidents_phase42 (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    severity TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    trigger TEXT,
    root_cause_hypothesis TEXT,
    impact TEXT,
    blast_radius TEXT,
    containment_state TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS security_remediation_plans_phase42 (
    id TEXT PRIMARY KEY,
    finding_id TEXT,
    incident_id TEXT,
    remediation_action TEXT NOT NULL,
    expected_impact TEXT,
    risk TEXT,
    blast_radius TEXT,
    rollback_strategy TEXT,
    governance_requirement TEXT,
    approval_state TEXT,
    safety_state TEXT,
    plan_fingerprint TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (finding_id) REFERENCES security_findings_phase42(id),
    FOREIGN KEY (incident_id) REFERENCES security_incidents_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_remediation_executions_phase42 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    execution_identity TEXT NOT NULL UNIQUE,
    provider TEXT,
    state TEXT NOT NULL DEFAULT 'created',
    attempt INTEGER DEFAULT 1,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    result TEXT,
    error_metadata TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (plan_id) REFERENCES security_remediation_plans_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_remediation_rollbacks_phase42 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    rollback_identity TEXT NOT NULL UNIQUE,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'planned',
    result TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES security_remediation_executions_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_containment_actions_phase42 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    containment_type TEXT NOT NULL,
    authorization TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    execution_id TEXT,
    rollback_capability TEXT,
    FOREIGN KEY (incident_id) REFERENCES security_incidents_phase42(id),
    FOREIGN KEY (asset_id) REFERENCES security_assets_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_escalations_phase42 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    escalation_target TEXT,
    reason TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES security_incidents_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_evidence_phase42 (
    id TEXT PRIMARY KEY,
    source TEXT,
    finding_id TEXT,
    incident_id TEXT,
    execution_id TEXT,
    hash_fingerprint TEXT,
    payload_reference TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (finding_id) REFERENCES security_findings_phase42(id),
    FOREIGN KEY (incident_id) REFERENCES security_incidents_phase42(id),
    FOREIGN KEY (execution_id) REFERENCES security_remediation_executions_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_lineage_phase42 (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    signal_id TEXT,
    finding_id TEXT,
    incident_id TEXT,
    plan_id TEXT,
    execution_id TEXT,
    rollback_id TEXT,
    evidence_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES security_assets_phase42(id)
);

CREATE TABLE IF NOT EXISTS security_learning_outcomes_phase42 (
    id TEXT PRIMARY KEY,
    source_incident_id TEXT,
    source_finding_id TEXT,
    detected_pattern TEXT,
    outcome TEXT,
    confidence REAL,
    recommended_future_action TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_incident_id) REFERENCES security_incidents_phase42(id),
    FOREIGN KEY (source_finding_id) REFERENCES security_findings_phase42(id)
);

CREATE INDEX idx_phase42_assets_criticality ON security_assets_phase42(criticality);
CREATE INDEX idx_phase42_findings_asset ON security_findings_phase42(asset_id);
CREATE INDEX idx_phase42_incidents_fingerprint ON security_incidents_phase42(fingerprint);
CREATE INDEX idx_phase42_executions_plan ON security_remediation_executions_phase42(plan_id);
