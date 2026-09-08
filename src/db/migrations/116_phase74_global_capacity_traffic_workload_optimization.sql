-- Phase 74: Global Autonomous Capacity, Traffic & Workload Optimization
-- SQLite-compatible

BEGIN;

CREATE TABLE IF NOT EXISTS capacity_models (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    fleet_id TEXT,
    project_id TEXT,
    environment TEXT,
    capacity_type TEXT NOT NULL CHECK (capacity_type IN ('compute','memory','execution_slots','agent','provider','network','storage','concurrency')),
    total REAL NOT NULL DEFAULT 0,
    allocated REAL NOT NULL DEFAULT 0,
    reserved REAL NOT NULL DEFAULT 0,
    active REAL NOT NULL DEFAULT 0,
    available REAL NOT NULL DEFAULT 0,
    degraded REAL NOT NULL DEFAULT 0,
    unavailable REAL NOT NULL DEFAULT 0,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    freshness TEXT NOT NULL DEFAULT 'CURRENT',
    source TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(region_id, fleet_id, project_id, environment, capacity_type, observed_at)
);

CREATE TABLE IF NOT EXISTS capacity_observations (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    fleet_id TEXT,
    project_id TEXT,
    environment TEXT,
    capacity_type TEXT NOT NULL,
    total REAL NOT NULL,
    allocated REAL NOT NULL,
    reserved REAL NOT NULL,
    active REAL NOT NULL,
    available REAL NOT NULL,
    degraded REAL NOT NULL DEFAULT 0,
    unavailable REAL NOT NULL DEFAULT 0,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    UNIQUE(region_id, fleet_id, project_id, environment, capacity_type, observed_at)
);

CREATE TABLE IF NOT EXISTS capacity_forecasts (
    id TEXT PRIMARY KEY,
    region_id TEXT,
    fleet_id TEXT,
    project_id TEXT,
    environment TEXT,
    capacity_type TEXT,
    forecast_horizon TEXT NOT NULL,
    projected_demand REAL,
    projected_available REAL,
    confidence REAL,
    assumptions TEXT,
    data_freshness TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workload_demands (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    cpu_requirement REAL,
    memory_requirement REAL,
    execution_slots INTEGER,
    concurrency INTEGER,
    provider_requirements TEXT,
    capability_requirements TEXT,
    latency_sensitivity TEXT,
    deadline TEXT,
    availability_requirement TEXT,
    region_affinity TEXT,
    region_exclusions TEXT,
    environment_requirements TEXT,
    project_constraints TEXT,
    migration_tolerance INTEGER DEFAULT 0,
    interruption_tolerance INTEGER DEFAULT 0,
    estimated_duration INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_decisions (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    region_id TEXT,
    fleet_id TEXT,
    placement_score REAL,
    confidence REAL,
    objectives TEXT,
    constraints TEXT,
    selected_candidate TEXT,
    rejected_candidates TEXT,
    reason TEXT,
    decision_state TEXT NOT NULL DEFAULT 'PROPOSED',
    decision_epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    UNIQUE(workload_id, decision_epoch)
);

CREATE TABLE IF NOT EXISTS placement_decisions (
    id TEXT PRIMARY KEY,
    optimization_id TEXT NOT NULL REFERENCES optimization_decisions(id),
    workload_id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    fleet_id TEXT,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    placement_state TEXT NOT NULL DEFAULT 'PLANNED',
    placement_epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS optimization_reservations (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    fleet_id TEXT,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    workload_id TEXT NOT NULL,
    reservation_state TEXT NOT NULL DEFAULT 'ACQUIRED',
    capacity_type TEXT,
    capacity_amount REAL,
    expires_at TEXT,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(region_id, fleet_id, project_id, environment, workload_id)
);

CREATE TABLE IF NOT EXISTS steering_plans (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    source_region_id TEXT,
    target_region_id TEXT,
    steering_type TEXT NOT NULL DEFAULT 'PREFERENCE',
    steering_state TEXT NOT NULL DEFAULT 'PROPOSED',
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    UNIQUE(workload_id, steering_type, epoch)
);

CREATE TABLE IF NOT EXISTS migration_plans (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    source_region_id TEXT NOT NULL,
    target_region_id TEXT NOT NULL,
    reason TEXT,
    expected_benefit TEXT,
    migration_risk TEXT,
    capacity_impact TEXT,
    dependencies TEXT,
    rollback_plan TEXT,
    verification_plan TEXT,
    governance_decision TEXT,
    safety_decision TEXT,
    approval_state TEXT DEFAULT 'NONE',
    migration_state TEXT NOT NULL DEFAULT 'PLANNED',
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    UNIQUE(workload_id, source_region_id, target_region_id, epoch)
);

CREATE TABLE IF NOT EXISTS optimization_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('global','region','fleet','project','environment')),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at TEXT,
    metadata TEXT DEFAULT '{}',
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS optimization_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    affected_region_id TEXT,
    affected_project_id TEXT,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS optimization_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    region_id TEXT,
    project_id TEXT,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_capacity_models_region ON capacity_models(region_id);
CREATE INDEX IF NOT EXISTS idx_capacity_observations_region ON capacity_observations(region_id);
CREATE INDEX IF NOT EXISTS idx_forecasts_region ON capacity_forecasts(region_id);
CREATE INDEX IF NOT EXISTS idx_demands_project ON workload_demands(project_id);
CREATE INDEX IF NOT EXISTS idx_optimization_decisions_workload ON optimization_decisions(workload_id);
CREATE INDEX IF NOT EXISTS idx_placements_optimization ON placement_decisions(optimization_id);
CREATE INDEX IF NOT EXISTS idx_reservations_region ON optimization_reservations(region_id);
CREATE INDEX IF NOT EXISTS idx_steering_workload ON steering_plans(workload_id);
CREATE INDEX IF NOT EXISTS idx_migrations_workload ON migration_plans(workload_id);
CREATE INDEX IF NOT EXISTS idx_optimization_cb_scope ON optimization_circuit_breakers(scope, entity_id);
CREATE INDEX IF NOT EXISTS idx_optimization_incidents_region ON optimization_incidents(affected_region_id);

COMMIT;