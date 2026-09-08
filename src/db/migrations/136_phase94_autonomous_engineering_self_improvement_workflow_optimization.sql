-- Phase 94: Autonomous Engineering Self-Improvement & Workflow Optimization
BEGIN;

CREATE TABLE IF NOT EXISTS workflow_definitions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    name TEXT NOT NULL,
    purpose TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    steps TEXT,
    dependencies TEXT,
    required_capabilities TEXT,
    resources TEXT,
    execution_constraints TEXT,
    risk TEXT,
    governance_requirements TEXT,
    safety_requirements TEXT,
    approval_requirements TEXT,
    rollback_requirements TEXT,
    verification_requirements TEXT,
    measurable_objectives TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS workflow_versions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    version INTEGER NOT NULL,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_steps (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    step_name TEXT NOT NULL,
    order_index INTEGER,
    depends_on TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_observations (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    metric_name TEXT NOT NULL,
    value REAL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT,
    provenance TEXT,
    freshness TEXT DEFAULT 'CURRENT',
    confidence REAL DEFAULT 0.5,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_baselines (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    baseline_version INTEGER NOT NULL,
    baseline_data TEXT,
    confidence REAL,
    freshness TEXT,
    provenance TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workflow_id, baseline_version)
);

CREATE TABLE IF NOT EXISTS workflow_bottlenecks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    bottleneck_type TEXT NOT NULL,
    evidence TEXT,
    severity TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS improvement_opportunities (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    description TEXT,
    evidence TEXT,
    expected_benefit REAL,
    uncertainty REAL,
    risk REAL,
    blast_radius REAL,
    reversibility TEXT,
    verification_strategy TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS improvement_candidates (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
    opportunity_id TEXT,
    candidate_name TEXT NOT NULL,
    current_behavior TEXT,
    proposed_behavior TEXT,
    expected_outcome TEXT,
    assumptions TEXT,
    dependencies TEXT,
    risks TEXT,
    resource_impact REAL,
    safety_impact TEXT,
    rollback_plan TEXT,
    verification_plan TEXT,
    state TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS improvement_candidate_versions (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES improvement_candidates(id),
    version INTEGER NOT NULL,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(candidate_id, version)
);

CREATE TABLE IF NOT EXISTS optimization_objectives (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES improvement_candidates(id),
    objective_type TEXT NOT NULL,
    objective_class TEXT NOT NULL DEFAULT 'SOFT' CHECK (objective_class IN ('HARD','SOFT')),
    weight REAL DEFAULT 1.0,
    threshold REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_constraints (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES improvement_candidates(id),
    constraint_type TEXT NOT NULL CHECK (constraint_type IN ('HARD','SOFT','PROTECTED')),
    field TEXT NOT NULL,
    operator TEXT,
    value TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_scores (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES improvement_candidates(id),
    score REAL,
    factors TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_simulations (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES improvement_candidates(id),
    scenario_type TEXT,
    result TEXT NOT NULL DEFAULT 'INCONCLUSIVE',
    confidence REAL,
    uncertainty REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_experiments (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES improvement_candidates(id),
    control_group TEXT,
    candidate_group TEXT,
    success_criteria TEXT,
    failure_criteria TEXT,
    safety_criteria TEXT,
    state TEXT NOT NULL DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_canaries (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES improvement_candidates(id),
    scope TEXT,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_activations (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES improvement_candidates(id),
    state TEXT NOT NULL DEFAULT 'PENDING',
    activated_at TEXT,
    verified_at TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_verifications (
    id TEXT PRIMARY KEY,
    activation_id TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'UNKNOWN',
    verified_at TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_rollbacks (
    id TEXT PRIMARY KEY,
    activation_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    rolled_back_at TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS optimization_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    incident_type TEXT,
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

CREATE TABLE IF NOT EXISTS optimization_replay (
    id TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;