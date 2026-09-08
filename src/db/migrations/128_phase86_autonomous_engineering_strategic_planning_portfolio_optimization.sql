-- Phase 86: Autonomous Engineering Strategic Planning, Portfolio Optimization & Long-Horizon Mission Coordination
BEGIN;

CREATE TABLE IF NOT EXISTS engineering_portfolios (
    id TEXT PRIMARY KEY,
    owner TEXT,
    organizational_scope TEXT,
    risk_profile TEXT,
    planning_horizon TEXT,
    budget REAL,
    capacity_envelope REAL,
    state TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_objectives (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    objective_type TEXT NOT NULL,
    target TEXT,
    priority INTEGER NOT NULL DEFAULT 1,
    weight REAL NOT NULL DEFAULT 1.0,
    baseline REAL,
    target_value REAL,
    tolerance REAL,
    objective_class TEXT NOT NULL DEFAULT 'SOFT' CHECK (objective_class IN ('HARD','SOFT')),
    measurement_method TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_goals (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    objective_id TEXT,
    goal TEXT NOT NULL,
    order_index INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_constraints (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    constraint_type TEXT NOT NULL CHECK (constraint_type IN ('HARD','SOFT')),
    field TEXT NOT NULL,
    operator TEXT,
    value TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_success_criteria (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    criterion TEXT NOT NULL,
    threshold REAL,
    comparison TEXT,
    required INTEGER NOT NULL DEFAULT 1,
    verification_state TEXT DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_budgets (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    limit_amount REAL NOT NULL,
    consumed_amount REAL NOT NULL DEFAULT 0,
    reserved_amount REAL NOT NULL DEFAULT 0,
    period TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_resource_envelopes (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    resource_type TEXT NOT NULL,
    limit_amount REAL NOT NULL,
    used_amount REAL NOT NULL DEFAULT 0,
    reserved_amount REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_missions (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    mission_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT,
    priority INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'REGISTERED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, mission_id)
);

CREATE TABLE IF NOT EXISTS portfolio_mission_dependencies (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    predecessor_mission_id TEXT,
    successor_mission_id TEXT,
    UNIQUE(portfolio_id, predecessor_mission_id, successor_mission_id)
);

CREATE TABLE IF NOT EXISTS portfolio_mission_conflicts (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    mission_a_id TEXT,
    mission_b_id TEXT,
    conflict_type TEXT,
    description TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_priorities (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    priority_score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_capacity_plans (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    resource_type TEXT,
    required_capacity REAL,
    available_capacity REAL,
    gap REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_demand_forecasts (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    horizon TEXT,
    demand REAL,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_resource_plans (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    resource_type TEXT,
    planned_allocation REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_strategies (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_strategy_evaluations (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES portfolio_strategies(id),
    objective_name TEXT NOT NULL,
    score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_simulations (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES portfolio_strategies(id),
    scenario_id TEXT,
    result TEXT,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_counterfactuals (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES portfolio_strategies(id),
    description TEXT,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_risk_assessments (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    risk_type TEXT,
    risk_level TEXT,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_plans (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES engineering_portfolios(id),
    strategy_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    rollback_plan TEXT,
    verification_plan TEXT,
    success_criteria TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, version)
);

CREATE TABLE IF NOT EXISTS portfolio_plan_versions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES portfolio_plans(id),
    version INTEGER NOT NULL,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_plan_missions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES portfolio_plans(id),
    mission_id TEXT,
    order_index INTEGER,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_execution_windows (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES portfolio_plans(id),
    mission_id TEXT,
    start_time TEXT,
    end_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_replanning_events (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    reason TEXT,
    new_plan_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_decisions (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    selected_strategy_id TEXT,
    rejected_strategies TEXT,
    rationale TEXT,
    confidence REAL,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_outcomes (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    objective_achievement REAL,
    cost_variance REAL,
    time_variance REAL,
    resource_variance REAL,
    reliability_improvement REAL,
    incidents INTEGER,
    regressions INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS portfolio_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS portfolio_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_audit (
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

CREATE TABLE IF NOT EXISTS portfolio_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portfolio_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;