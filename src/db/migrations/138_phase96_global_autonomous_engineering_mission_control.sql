-- Migration 138: Phase 96 Global Autonomous Engineering Mission Control
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS global_missions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    business_unit_id TEXT,
    portfolio_id TEXT,
    program_id TEXT,
    project_id TEXT,
    environment_id TEXT,
    regions TEXT NOT NULL DEFAULT '[]',
    fleets TEXT NOT NULL DEFAULT '[]',
    objective TEXT NOT NULL,
    success_criteria TEXT NOT NULL DEFAULT '[]',
    constraints TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 0,
    risk TEXT NOT NULL DEFAULT 'UNKNOWN',
    required_capabilities TEXT NOT NULL DEFAULT '[]',
    resource_envelope TEXT NOT NULL DEFAULT '{}',
    deadline TEXT,
    execution_policy TEXT NOT NULL DEFAULT '{}',
    governance_requirements TEXT NOT NULL DEFAULT '[]',
    safety_requirements TEXT NOT NULL DEFAULT '[]',
    approval_requirements TEXT NOT NULL DEFAULT '[]',
    recovery_requirements TEXT NOT NULL DEFAULT '[]',
    rollback_requirements TEXT NOT NULL DEFAULT '[]',
    verification_requirements TEXT NOT NULL DEFAULT '[]',
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'INTAKE',
    version INTEGER NOT NULL DEFAULT 1,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_versions (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL DEFAULT 'system',
    reason TEXT,
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    UNIQUE(mission_id, version)
);

CREATE TABLE IF NOT EXISTS mission_objectives (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    objective_type TEXT NOT NULL CHECK (objective_type IN ('PRIMARY','SECONDARY')),
    description TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    is_hard INTEGER NOT NULL DEFAULT 0,
    precedence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES mission_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_success_criteria (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    criterion TEXT NOT NULL,
    is_measurable INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES mission_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_constraints (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    constraint_type TEXT NOT NULL,
    constraint_value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES mission_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_priorities (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    priority INTEGER NOT NULL,
    rationale TEXT,
    calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
    calculated_by TEXT NOT NULL DEFAULT 'system',
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_dependencies (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    depends_on_mission_id TEXT NOT NULL,
    dependency_type TEXT NOT NULL DEFAULT 'BLOCKS',
    is_satisfied INTEGER NOT NULL DEFAULT 0,
    timeout_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    CHECK (mission_id <> depends_on_mission_id)
);

CREATE TABLE IF NOT EXISTS mission_conflicts (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    conflicting_mission_id TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    resolution_status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (conflicting_mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_alignments (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('ORGANIZATION','PORTFOLIO','PROGRAM','PROJECT','STRATEGIC_OBJECTIVE','ENVIRONMENT')),
    entity_id TEXT NOT NULL,
    alignment_status TEXT NOT NULL DEFAULT 'ALIGNED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_strategies (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    strategy_data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT,
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    UNIQUE(mission_id, version)
);

CREATE TABLE IF NOT EXISTS mission_strategy_versions (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (strategy_id) REFERENCES mission_strategies(id) ON DELETE CASCADE,
    UNIQUE(strategy_id, version)
);

CREATE TABLE IF NOT EXISTS mission_decisions (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    strategy_id TEXT,
    decision_context TEXT NOT NULL,
    selected_alternative_id TEXT,
    confidence REAL,
    authority TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (strategy_id) REFERENCES mission_strategies(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mission_decision_alternatives (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    alternative_data TEXT NOT NULL,
    score REAL,
    rejected INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (decision_id) REFERENCES mission_decisions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_resource_envelopes (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    compute_units INTEGER NOT NULL DEFAULT 0,
    memory_mb INTEGER NOT NULL DEFAULT 0,
    execution_slots INTEGER NOT NULL DEFAULT 0,
    agent_count INTEGER NOT NULL DEFAULT 0,
    provider_quota TEXT NOT NULL DEFAULT '{}',
    budget REAL,
    concurrency INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_capacity_requirements (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    required_amount REAL NOT NULL,
    unit TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_resource_allocations (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    envelope_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    allocated_amount REAL NOT NULL,
    consumed_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ALLOCATED',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (envelope_id) REFERENCES mission_resource_envelopes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_execution_plans (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    plan_data TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (strategy_id) REFERENCES mission_strategies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_execution_steps (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    dependencies TEXT NOT NULL DEFAULT '[]',
    checkpoint_after INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (plan_id) REFERENCES mission_execution_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_assignments (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    execution_step_id TEXT,
    assignee_type TEXT NOT NULL,
    assignee_id TEXT NOT NULL,
    assignment_status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (execution_step_id) REFERENCES mission_execution_steps(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mission_routes (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    region TEXT,
    fleet_id TEXT,
    provider_id TEXT,
    agent_id TEXT,
    collective_team_id TEXT,
    workflow_id TEXT,
    routing_decision TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_checkpoints (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    execution_step_id TEXT,
    checkpoint_data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (execution_step_id) REFERENCES mission_execution_steps(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mission_health_snapshots (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    health_status TEXT NOT NULL,
    metrics TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_progress (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    objective_completion REAL NOT NULL DEFAULT 0,
    execution_progress REAL NOT NULL DEFAULT 0,
    completed_steps INTEGER NOT NULL DEFAULT 0,
    failed_steps INTEGER NOT NULL DEFAULT 0,
    blocked_steps INTEGER NOT NULL DEFAULT 0,
    resource_utilization REAL NOT NULL DEFAULT 0,
    deadline_progress REAL NOT NULL DEFAULT 0,
    verification_progress REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_outcomes (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    outcome_status TEXT NOT NULL,
    details TEXT,
    verified_at TEXT,
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_verifications (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    verification_type TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence TEXT,
    verified_by TEXT NOT NULL DEFAULT 'system',
    verified_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_replans (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    old_strategy_id TEXT,
    new_strategy_id TEXT,
    replan_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (old_strategy_id) REFERENCES mission_strategies(id) ON DELETE SET NULL,
    FOREIGN KEY (new_strategy_id) REFERENCES mission_strategies(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mission_replan_versions (
    id TEXT PRIMARY KEY,
    replan_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (replan_id) REFERENCES mission_replans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_approvals (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    mission_version INTEGER NOT NULL,
    requested_operation TEXT NOT NULL,
    strategy_version INTEGER,
    policy_context TEXT,
    risk_classification TEXT,
    status TEXT NOT NULL DEFAULT 'REQUESTED',
    requested_by TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    expires_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_governance_decisions (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    decided_by TEXT NOT NULL DEFAULT 'system',
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_safety_decisions (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    decided_by TEXT NOT NULL DEFAULT 'system',
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_interventions (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    intervention_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    authorization TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_overrides (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    override_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    authorization TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('GLOBAL','ORGANIZATION','PORTFOLIO','PROJECT','ENVIRONMENT','REGION','FLEET','MISSION')),
    scope_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    half_open_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS mission_failure_domains (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    failure_scope TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_incidents (
    id TEXT PRIMARY KEY,
    mission_id TEXT,
    incident_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mission_escalations (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    escalation_level INTEGER NOT NULL,
    reason TEXT,
    escalated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (incident_id) REFERENCES mission_incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_recovery_plans (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    plan_data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_rollbacks (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    rollback_plan_id TEXT,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    executed_at TEXT,
    verified_at TEXT,
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE,
    FOREIGN KEY (rollback_plan_id) REFERENCES mission_recovery_plans(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mission_learning (
    id TEXT PRIMARY KEY,
    mission_id TEXT,
    learning_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mission_evidence (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    mission_version INTEGER,
    evidence_type TEXT NOT NULL,
    evidence_data TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_audit (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    actor TEXT NOT NULL,
    reason TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_lineage (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    node_id TEXT NOT NULL,
    parent_node_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_replay (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    replay_input_hash TEXT NOT NULL,
    replay_output_hash TEXT NOT NULL,
    divergence INTEGER NOT NULL DEFAULT 0,
    replayed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES global_missions(id) ON DELETE CASCADE
);

CREATE INDEX idx_global_missions_org ON global_missions(organization_id);
CREATE INDEX idx_global_missions_project ON global_missions(project_id);
CREATE INDEX idx_global_missions_state ON global_missions(state);
CREATE INDEX idx_mission_versions_mission ON mission_versions(mission_id);
CREATE INDEX idx_mission_dependencies_mission ON mission_dependencies(mission_id);
CREATE INDEX idx_mission_incidents_mission ON mission_incidents(mission_id);
CREATE INDEX idx_mission_evidence_mission ON mission_evidence(mission_id);
CREATE INDEX idx_mission_audit_mission ON mission_audit(mission_id);
CREATE INDEX idx_mission_lineage_mission ON mission_lineage(mission_id);
