-- Phase 41: Autonomous Production Reliability & SRE Intelligence

CREATE TABLE IF NOT EXISTS sre_services_phase41 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    environment TEXT,
    version TEXT,
    owner TEXT,
    criticality TEXT NOT NULL DEFAULT 'unknown'
        CHECK (criticality IN ('low','medium','high','critical','unknown')),
    protected INTEGER NOT NULL DEFAULT 0,
    health_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (health_state IN ('healthy','degraded','unhealthy','unknown')),
    reliability_state TEXT NOT NULL DEFAULT 'unknown',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sre_slis_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    aggregation TEXT,
    evaluation_window TEXT,
    threshold_config TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_slos_phase41 (
    id TEXT PRIMARY KEY,
    sli_id TEXT NOT NULL,
    target REAL NOT NULL,
    compliance_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (compliance_state IN ('compliant','at_risk','violated','unknown')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sli_id) REFERENCES sre_slis_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_error_budgets_phase41 (
    id TEXT PRIMARY KEY,
    slo_id TEXT NOT NULL,
    budget_amount REAL NOT NULL,
    consumed_amount REAL NOT NULL DEFAULT 0,
    remaining_amount REAL NOT NULL,
    burn_rate REAL NOT NULL DEFAULT 0,
    exhaustion_prediction TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (slo_id) REFERENCES sre_slos_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_reliability_findings_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    finding_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'unknown',
    details TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_reliability_risks_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'unknown'
        CHECK (risk_level IN ('low','medium','high','critical','unknown')),
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_change_correlations_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    change_ref TEXT,
    correlation_strength TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL,
    evidence TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_incident_correlations_phase41 (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL,
    incident_id TEXT,
    correlation_type TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (finding_id) REFERENCES sre_reliability_findings_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_root_cause_hypotheses_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    hypothesis_type TEXT NOT NULL,
    confidence REAL,
    evidence_refs TEXT,
    affected_resources TEXT,
    blast_radius TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_remediation_plans_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    finding_id TEXT,
    reason TEXT,
    target TEXT,
    action TEXT,
    expected_effect TEXT,
    risk TEXT,
    blast_radius TEXT,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    governance_state TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_remediation_executions_phase41 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'created'
        CHECK (state IN ('created','approved','running','paused','halted','succeeded','failed','rolling_back','rolled_back')),
    attempts INTEGER DEFAULT 1,
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES sre_remediation_plans_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_remediation_verifications_phase41 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    health_result TEXT,
    slo_result TEXT,
    verification_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (verification_state IN ('recovered','partially_recovered','not_recovered','regressed','unknown')),
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES sre_remediation_executions_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_remediation_rollbacks_phase41 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    verification_result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES sre_remediation_executions_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_remediation_circuit_breakers_phase41 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_threshold INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED'
        CHECK (state IN ('CLOSED','OPEN')),
    opened_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sre_incidents_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    resolution_state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_escalations_phase41 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    acknowledged INTEGER DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES sre_incidents_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_evidence_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_audit_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_lineage_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    finding_id TEXT,
    risk_id TEXT,
    incident_id TEXT,
    execution_id TEXT,
    rollback_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE TABLE IF NOT EXISTS sre_learning_phase41 (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES sre_services_phase41(id)
);

CREATE INDEX idx_phase41_services_health ON sre_services_phase41(health_state);
CREATE INDEX idx_phase41_findings_service ON sre_reliability_findings_phase41(service_id);
CREATE INDEX idx_phase41_executions_plan ON sre_remediation_executions_phase41(plan_id);
CREATE INDEX idx_phase41_incidents_service ON sre_incidents_phase41(service_id);
