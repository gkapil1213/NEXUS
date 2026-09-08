-- Phase 95: Autonomous Engineering Risk, Resilience & Systemic Failure Prevention
BEGIN;

CREATE TABLE IF NOT EXISTS risk_domains (
    id TEXT PRIMARY KEY,
    domain_type TEXT NOT NULL,
    organization_id TEXT,
    project_id TEXT,
    environment TEXT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_entities (
    id TEXT PRIMARY KEY,
    domain_id TEXT REFERENCES risk_domains(id),
    entity_type TEXT NOT NULL,
    name TEXT NOT NULL,
    criticality TEXT,
    health TEXT,
    owner TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_relationships (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_observations (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    metric_name TEXT NOT NULL,
    value REAL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT,
    freshness TEXT DEFAULT 'CURRENT',
    confidence REAL DEFAULT 0.5,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_baselines (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    baseline_version INTEGER NOT NULL,
    baseline_data TEXT,
    confidence REAL,
    freshness TEXT DEFAULT 'CURRENT',
    provenance TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_indicators (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    indicator_type TEXT NOT NULL,
    value REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_assessments (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    risk_level TEXT,
    confidence REAL,
    uncertainty REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_risk_assessments (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    risk_level TEXT,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS concentration_risks (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    concentration_ratio REAL,
    criticality TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS single_points_of_failure (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    spof_type TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS correlated_failure_patterns (
    id TEXT PRIMARY KEY,
    pattern_type TEXT,
    description TEXT,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cascading_failure_models (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT,
    affected_entities TEXT,
    propagation_depth INTEGER,
    propagation_breadth INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failure_propagation_events (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT,
    affected_entities TEXT,
    propagation_depth INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resilience_profiles (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    redundancy REAL,
    diversity REAL,
    failover REAL,
    recovery_time REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resilience_scores (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    resilience_score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recovery_capabilities (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    recovery_objective TEXT,
    recovery_time REAL,
    recovery_success REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blast_radius_assessments (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    blast_radius_type TEXT,
    affected_entities TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_scenarios (
    id TEXT PRIMARY KEY,
    scenario_type TEXT,
    assumptions TEXT,
    scope TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_simulations (
    id TEXT PRIMARY KEY,
    scenario_id TEXT,
    result TEXT DEFAULT 'INCONCLUSIVE',
    confidence REAL,
    uncertainty REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prevention_candidates (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    candidate_name TEXT,
    expected_risk_reduction REAL,
    risk REAL,
    blast_radius REAL,
    reversibility TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS containment_plans (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    plan_content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS containment_actions (
    id TEXT PRIMARY KEY,
    plan_id TEXT,
    action_type TEXT,
    state TEXT DEFAULT 'EXECUTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recovery_plans (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    recovery_content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resilience_experiments (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    experiment_type TEXT,
    state TEXT DEFAULT 'CREATED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resilience_canaries (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    scope TEXT,
    state TEXT DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resilience_verifications (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    result TEXT DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_regressions (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    regression_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_drift (
    id TEXT PRIMARY KEY,
    entity_id TEXT,
    drift_type TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    closed_at TEXT,
    failure_count INTEGER DEFAULT 0,
    UNIQUE(scope, entity_id)
);

CREATE TABLE IF NOT EXISTS systemic_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT,
    incident_type TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS systemic_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_audit (
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

CREATE TABLE IF NOT EXISTS systemic_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS systemic_replay (
    id TEXT PRIMARY KEY,
    decision_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;