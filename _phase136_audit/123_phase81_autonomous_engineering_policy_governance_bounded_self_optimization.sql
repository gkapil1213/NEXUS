-- Phase 81: Autonomous Engineering Policy, Governance & Bounded Self-Optimization
BEGIN;

CREATE TABLE IF NOT EXISTS engineering_policies (
    id TEXT PRIMARY KEY,
    policy_name TEXT NOT NULL,
    policy_type TEXT NOT NULL,
    scope TEXT NOT NULL,
    project_id TEXT,
    environment TEXT,
    fleet_id TEXT,
    region_id TEXT,
    resource_class TEXT,
    priority INTEGER NOT NULL DEFAULT 5,
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    owner TEXT,
    risk_classification TEXT,
    autonomy_class TEXT NOT NULL DEFAULT 'CLASS_A',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(policy_name, project_id, environment, fleet_id, region_id)
);

CREATE TABLE IF NOT EXISTS engineering_policy_versions (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    version INTEGER NOT NULL,
    content TEXT,
    constraints TEXT,
    scope TEXT,
    creator TEXT,
    reason TEXT,
    provenance TEXT,
    parent_version INTEGER,
    approval_state TEXT,
    activation_timestamp TEXT,
    rollback_target INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(policy_id, version)
);

CREATE TABLE IF NOT EXISTS policy_constraints (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    constraint_type TEXT NOT NULL CHECK (constraint_type IN ('HARD','SOFT')),
    field TEXT NOT NULL,
    min_value REAL,
    max_value REAL,
    step_size REAL,
    rate_limit REAL,
    cumulative_limit REAL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_objectives (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    metric TEXT NOT NULL,
    target REAL,
    threshold REAL,
    direction TEXT NOT NULL CHECK (direction IN ('MINIMIZE','MAXIMIZE')),
    weight REAL NOT NULL DEFAULT 1.0,
    scope TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_effectiveness (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    metric TEXT,
    expected_objective TEXT,
    actual_outcome REAL,
    success_rate REAL,
    failure_rate REAL,
    resource_efficiency REAL,
    latency REAL,
    cost REAL,
    reliability REAL,
    safety_violations INTEGER,
    incidents INTEGER,
    regressions INTEGER,
    recovery_frequency INTEGER,
    rollback_frequency INTEGER,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_optimization_candidates (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    parent_version INTEGER NOT NULL,
    proposed_changes TEXT,
    expected_benefit TEXT,
    expected_risk TEXT,
    affected_scope TEXT,
    constraints TEXT,
    reason TEXT,
    evidence TEXT,
    confidence REAL,
    provenance TEXT,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_candidate_scores (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES policy_optimization_candidates(id),
    score REAL,
    objective_scores TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_conflicts (
    id TEXT PRIMARY KEY,
    policy_a_id TEXT NOT NULL,
    policy_b_id TEXT NOT NULL,
    conflict_type TEXT,
    description TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_simulations (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES policy_optimization_candidates(id),
    result TEXT NOT NULL DEFAULT 'INCONCLUSIVE',
    expected_benefit TEXT,
    expected_cost REAL,
    resource_impact REAL,
    workload_impact REAL,
    blast_radius REAL,
    rollback_behavior TEXT,
    circuit_breaker_behavior TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_approvals (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES policy_optimization_candidates(id),
    approver TEXT,
    state TEXT NOT NULL DEFAULT 'PENDING',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(candidate_id)
);

CREATE TABLE IF NOT EXISTS policy_activations (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES policy_optimization_candidates(id),
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    activated_at TEXT,
    canary_scope TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_canaries (
    id TEXT PRIMARY KEY,
    activation_id TEXT NOT NULL REFERENCES policy_activations(id),
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    scope_subset TEXT,
    observed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_observations (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    metric TEXT,
    observed_value REAL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_regressions (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    regression_type TEXT,
    severity TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_rollbacks (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    from_version INTEGER,
    to_version INTEGER,
    state TEXT NOT NULL DEFAULT 'ROLLED_BACK',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_drift (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES engineering_policies(id),
    drift_type TEXT,
    details TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_optimization_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS policy_change_rate_limits (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    max_changes INTEGER NOT NULL DEFAULT 1,
    window_seconds INTEGER NOT NULL DEFAULT 60,
    used_changes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_audit (
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

CREATE TABLE IF NOT EXISTS policy_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_engineering_policies_scope ON engineering_policies(scope, project_id, environment);
CREATE INDEX IF NOT EXISTS idx_policy_versions_policy ON engineering_policy_versions(policy_id, version);
CREATE INDEX IF NOT EXISTS idx_policy_candidates_policy ON policy_optimization_candidates(policy_id);
CREATE INDEX IF NOT EXISTS idx_policy_break_scope ON policy_optimization_breakers(scope, entity_id);

COMMIT;