-- Phase 78: Autonomous Engineering Demand Forecasting, Capacity Planning & Predictive Resource Intelligence
BEGIN;

CREATE TABLE IF NOT EXISTS demand_observations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    fleet_id TEXT,
    region_id TEXT,
    workload_type TEXT,
    resource_class TEXT NOT NULL,
    requested_capacity REAL,
    consumed_capacity REAL,
    duration INTEGER,
    queue_time INTEGER,
    execution_time INTEGER,
    success INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 5,
    incident_id TEXT,
    provider_id TEXT,
    agent_id TEXT,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demand_series (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    environment TEXT,
    fleet_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    metric TEXT NOT NULL,
    time_bucket TEXT NOT NULL,
    value REAL NOT NULL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, metric, time_bucket)
);

CREATE TABLE IF NOT EXISTS demand_forecasts (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    environment TEXT,
    fleet_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    horizon TEXT NOT NULL,
    forecast_value REAL NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    lower_bound REAL,
    upper_bound REAL,
    model_method TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capacity_gaps (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    environment TEXT,
    fleet_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    forecast_id TEXT,
    gap_type TEXT NOT NULL CHECK (gap_type IN ('SHORTAGE','SURPLUS','RISK','NONE')),
    expected_date TEXT,
    gap_amount REAL,
    severity TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capacity_plans (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    environment TEXT,
    fleet_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    horizon TEXT,
    demand_forecast REAL,
    available_capacity REAL,
    reserved_capacity REAL,
    gap_amount REAL,
    recommendation TEXT,
    provider_candidates TEXT,
    estimated_cost REAL,
    budget_impact REAL,
    quota_impact REAL,
    confidence REAL,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS planning_recommendations (
    id TEXT PRIMARY KEY,
    plan_id TEXT,
    recommendation_type TEXT NOT NULL,
    rationale TEXT,
    evidence TEXT,
    forecast_id TEXT,
    confidence REAL,
    expected_impact TEXT,
    risk TEXT,
    economic_impact REAL,
    governance_state TEXT,
    safety_state TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forecast_alerts (
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

CREATE TABLE IF NOT EXISTS forecast_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS forecast_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS forecast_audit (
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

CREATE TABLE IF NOT EXISTS forecast_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS forecast_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_demand_obs_project ON demand_observations(project_id, environment);
CREATE INDEX IF NOT EXISTS idx_demand_series_metric ON demand_series(metric, time_bucket);
CREATE INDEX IF NOT EXISTS idx_demand_forecasts_project ON demand_forecasts(project_id, environment);
CREATE INDEX IF NOT EXISTS idx_capacity_gaps_project ON capacity_gaps(project_id);


CREATE TABLE IF NOT EXISTS forecast_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);
COMMIT;