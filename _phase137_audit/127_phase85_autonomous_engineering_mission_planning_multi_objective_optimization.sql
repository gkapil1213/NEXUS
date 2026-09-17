-- Phase 85: Autonomous Engineering Mission Planning & Multi-Objective Optimization
BEGIN;

CREATE TABLE IF NOT EXISTS engineering_missions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    owner TEXT,
    objective TEXT NOT NULL,
    scope TEXT,
    priority INTEGER NOT NULL DEFAULT 5,
    risk TEXT,
    deadline TEXT,
    state TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_objectives (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES engineering_missions(id),
    objective_type TEXT NOT NULL,
    target TEXT,
    priority INTEGER NOT NULL DEFAULT 1,
    weight REAL NOT NULL DEFAULT 1.0,
    measurement_method TEXT,
    baseline REAL,
    desired_outcome TEXT,
    tolerance REAL,
    objective_class TEXT NOT NULL DEFAULT 'SOFT' CHECK (objective_class IN ('HARD','SOFT')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_constraints (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES engineering_missions(id),
    constraint_type TEXT NOT NULL CHECK (constraint_type IN ('HARD','SOFT')),
    field TEXT NOT NULL,
    operator TEXT,
    value TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_success_criteria (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES engineering_missions(id),
    criterion TEXT NOT NULL,
    threshold REAL,
    comparison TEXT,
    required INTEGER NOT NULL DEFAULT 1,
    verification_state TEXT DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_goals (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES engineering_missions(id),
    goal TEXT NOT NULL,
    order_index INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_tasks (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES engineering_missions(id),
    task_type TEXT NOT NULL,
    project_id TEXT,
    environment TEXT,
    operation TEXT,
    capabilities TEXT,
    resource_requirements TEXT,
    risk TEXT,
    verification_requirements TEXT,
    rollback_requirements TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_task_dependencies (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    predecessor_task_id TEXT,
    successor_task_id TEXT,
    UNIQUE(mission_id, predecessor_task_id, successor_task_id)
);

CREATE TABLE IF NOT EXISTS mission_strategies (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES engineering_missions(id),
    name TEXT NOT NULL,
    description TEXT,
    execution_order TEXT,
    fleet_id TEXT,
    region_id TEXT,
    provider_id TEXT,
    rollout_method TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_strategy_evaluations (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES mission_strategies(id),
    objective_name TEXT NOT NULL,
    score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_simulations (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES mission_strategies(id),
    scenario_id TEXT,
    result TEXT,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_decisions (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    selected_strategy_id TEXT,
    rejected_strategies TEXT,
    rationale TEXT,
    confidence REAL,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_plans (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES engineering_missions(id),
    strategy_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    rollback_plan TEXT,
    verification_plan TEXT,
    success_criteria TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(mission_id, version)
);

CREATE TABLE IF NOT EXISTS mission_plan_tasks (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES mission_plans(id),
    task_id TEXT,
    order_index INTEGER,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_execution_plans (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES mission_plans(id),
    state TEXT NOT NULL DEFAULT 'PENDING',
    started_at TEXT,
    completed_at TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_replanning_events (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    reason TEXT,
    new_plan_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_outcomes (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    objective_achievement REAL,
    constraint_adherence REAL,
    actual_cost REAL,
    actual_time REAL,
    reliability REAL,
    incidents INTEGER,
    regressions INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS mission_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mission_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_audit (
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

CREATE TABLE IF NOT EXISTS mission_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mission_project ON engineering_missions(project_id, environment);
CREATE INDEX IF NOT EXISTS idx_mission_objectives_mission ON mission_objectives(mission_id);
CREATE INDEX IF NOT EXISTS idx_mission_strategies_mission ON mission_strategies(mission_id);
CREATE INDEX IF NOT EXISTS idx_mission_plans_mission ON mission_plans(mission_id, version);

COMMIT;