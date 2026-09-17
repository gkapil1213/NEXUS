-- Phase 40: Autonomous Production Incident Command, Reliability Recovery & Self-Healing Operations

CREATE TABLE IF NOT EXISTS incidents_phase40 (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'detected'
        CHECK (status IN ('detected','acknowledged','investigating','mitigating','recovering','monitoring','resolved','closed','escalated','halted')),
    severity TEXT NOT NULL DEFAULT 'unknown'
        CHECK (severity IN ('informational','low','medium','high','critical','unknown')),
    priority INTEGER NOT NULL DEFAULT 3,
    source TEXT,
    environment TEXT,
    service_id TEXT,
    resource_id TEXT,
    commander TEXT,
    correlation_state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS incident_signals_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT,
    signal_type TEXT NOT NULL,
    observed_value TEXT,
    threshold_context TEXT,
    source TEXT,
    signal_fingerprint TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS incident_timeline_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    previous_state TEXT,
    new_state TEXT,
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS incident_impact_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    affected_services TEXT,
    affected_environments TEXT,
    affected_resources TEXT,
    customer_impact TEXT,
    business_impact TEXT,
    technical_impact TEXT,
    reliability_impact TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS incident_blast_radius_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    resource_count INTEGER DEFAULT 0,
    service_count INTEGER DEFAULT 0,
    environment_count INTEGER DEFAULT 0,
    dependency_depth INTEGER DEFAULT 0,
    critical_resources INTEGER DEFAULT 0,
    customer_facing INTEGER DEFAULT 0,
    classification TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS incident_root_causes_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    candidate_cause TEXT NOT NULL,
    confidence REAL DEFAULT 0,
    evidence_refs TEXT,
    is_selected INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS recovery_plans_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    objective TEXT,
    actions_json TEXT,
    prerequisites TEXT,
    expected_outcome TEXT,
    risk TEXT,
    blast_radius TEXT,
    governance_requirement TEXT,
    safety_requirement TEXT,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS recovery_governance_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('ALLOW','APPROVAL_REQUIRED','DENY','FREEZE')),
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS recovery_safety_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    safe INTEGER NOT NULL DEFAULT 1,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS recovery_executions_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    plan_id TEXT,
    action TEXT,
    state TEXT NOT NULL DEFAULT 'created'
        CHECK (state IN ('created','approved','running','paused','halted','succeeded','failed','rolling_back','rolled_back')),
    attempts INTEGER DEFAULT 1,
    provider TEXT,
    result TEXT,
    error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id),
    FOREIGN KEY (plan_id) REFERENCES recovery_plans_phase40(id)
);

CREATE TABLE IF NOT EXISTS recovery_verifications_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    execution_id TEXT,
    health_result TEXT,
    slo_result TEXT,
    regression_result TEXT,
    verification_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (verification_state IN ('recovered','recovering','failed','regressed','unknown')),
    evidence_ref TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id),
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase40(id)
);

CREATE TABLE IF NOT EXISTS recovery_rollbacks_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    execution_id TEXT,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    verification_result TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id),
    FOREIGN KEY (execution_id) REFERENCES recovery_executions_phase40(id)
);

CREATE TABLE IF NOT EXISTS recovery_circuit_breakers_phase40 (
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

CREATE TABLE IF NOT EXISTS incident_escalations_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT,
    target TEXT,
    acknowledged INTEGER DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS incident_evidence_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS incident_audit_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS incident_lineage_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    source_signal_id TEXT,
    execution_id TEXT,
    rollback_id TEXT,
    escalation_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE TABLE IF NOT EXISTS incident_learning_phase40 (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incidents_phase40(id)
);

CREATE INDEX idx_phase40_incidents_status ON incidents_phase40(status);
CREATE INDEX idx_phase40_signals_incident ON incident_signals_phase40(incident_id);
CREATE INDEX idx_phase40_executions_incident ON recovery_executions_phase40(incident_id);
CREATE INDEX idx_phase40_rollbacks_incident ON recovery_rollbacks_phase40(incident_id);
