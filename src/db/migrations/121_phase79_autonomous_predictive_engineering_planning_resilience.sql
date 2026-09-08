-- Phase 79: Autonomous Predictive Engineering Planning, Preemptive Capacity Orchestration & Resilience Management
BEGIN;

CREATE TABLE IF NOT EXISTS predictive_risks (
    id TEXT PRIMARY KEY,
    risk_type TEXT NOT NULL,
    affected_entity_id TEXT,
    forecast_source TEXT,
    forecast_horizon TEXT,
    probability REAL,
    impact REAL,
    confidence REAL,
    severity TEXT,
    failure_domain TEXT,
    detection_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    recommended_response TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intervention_candidates (
    id TEXT PRIMARY KEY,
    risk_id TEXT NOT NULL REFERENCES predictive_risks(id),
    action TEXT NOT NULL,
    target TEXT,
    expected_benefit TEXT,
    cost REAL,
    risk TEXT,
    capacity_impact REAL,
    budget_impact REAL,
    quota_impact REAL,
    reliability_impact REAL,
    blast_radius REAL,
    dependencies TEXT,
    approval_requirements TEXT,
    rollback_availability INTEGER NOT NULL DEFAULT 0,
    verification_availability INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_plans (
    id TEXT PRIMARY KEY,
    objective TEXT,
    risk_ids TEXT,
    assumptions TEXT,
    forecast_ids TEXT,
    confidence REAL,
    constraints TEXT,
    selected_interventions TEXT,
    expected_outcome TEXT,
    cost REAL,
    resource_impact REAL,
    rollback_plan TEXT,
    verification_plan TEXT,
    governance_decision TEXT,
    safety_decision TEXT,
    authorization_state TEXT,
    state TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictive_plan_items (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES predictive_plans(id),
    intervention_id TEXT,
    order_index INTEGER,
    depends_on TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intervention_dependencies (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    predecessor_id TEXT,
    successor_id TEXT,
    UNIQUE(plan_id, predecessor_id, successor_id)
);

CREATE TABLE IF NOT EXISTS intervention_authorizations (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    intervention_id TEXT,
    approved_by TEXT,
    approval_state TEXT NOT NULL DEFAULT 'PENDING',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intervention_executions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    intervention_id TEXT,
    state TEXT NOT NULL DEFAULT 'NOT_STARTED',
    started_at TEXT,
    completed_at TEXT,
    failure_reason TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intervention_verifications (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES intervention_executions(id),
    result TEXT NOT NULL DEFAULT 'UNKNOWN',
    verified_at TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preemptive_capacity_actions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    provider_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    quantity REAL,
    expected_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preemptive_procurement_actions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    provider_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    quantity REAL,
    expected_cost REAL,
    budget_impact REAL,
    quota_impact REAL,
    lead_time_days INTEGER,
    confidence REAL,
    approval_state TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS preemptive_scaling_actions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    provider_id TEXT,
    fleet_id TEXT,
    resource_class TEXT,
    direction TEXT CHECK (direction IN ('UP','DOWN')),
    quantity REAL,
    expected_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS preemptive_reservation_actions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    provider_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    quantity REAL,
    start_time TEXT,
    end_time TEXT,
    estimated_cost REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS resilience_plans (
    id TEXT PRIMARY KEY,
    plan_id TEXT REFERENCES predictive_plans(id),
    resilience_score REAL,
    provider_diversity INTEGER,
    region_diversity INTEGER,
    spare_capacity REAL,
    recovery_capacity REAL,
    budget_headroom REAL,
    quota_headroom REAL,
    assessment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resilience_assessments (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    resilience_score REAL,
    gaps TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS future_capacity_gaps (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    environment TEXT,
    fleet_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    gap_amount REAL,
    gap_date TEXT,
    severity TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS future_budget_risks (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    budget_id TEXT,
    projected_exhaustion_date TEXT,
    risk_level TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS future_quota_risks (
    id TEXT PRIMARY KEY,
    quota_id TEXT,
    projected_exhaustion_date TEXT,
    risk_level TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS future_provider_risks (
    id TEXT PRIMARY KEY,
    provider_id TEXT,
    risk_type TEXT,
    severity TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS future_region_risks (
    id TEXT PRIMARY KEY,
    region_id TEXT,
    risk_type TEXT,
    severity TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS planning_alerts (
    id TEXT PRIMARY KEY,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    entity_id TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS planning_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS planning_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS planning_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS planning_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS planning_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS planning_replay_records (
    id TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictive_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_predictive_risks_type ON predictive_risks(risk_type);
CREATE INDEX IF NOT EXISTS idx_intervention_candidates_risk ON intervention_candidates(risk_id);
CREATE INDEX IF NOT EXISTS idx_predictive_plans_state ON predictive_plans(state);
CREATE INDEX IF NOT EXISTS idx_planning_alerts_type ON planning_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_planning_incidents_type ON planning_incidents(incident_type);

COMMIT;