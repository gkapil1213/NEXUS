-- Phase 84: Autonomous Engineering Digital Twin, Scenario Simulation & Counterfactual Planning
BEGIN;

CREATE TABLE IF NOT EXISTS digital_twin_snapshots (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    provenance TEXT,
    freshness TEXT,
    completeness TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(version)
);

CREATE TABLE IF NOT EXISTS digital_twin_entities (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES digital_twin_snapshots(id),
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state_json TEXT,
    provenance TEXT,
    observed_at TEXT
);

CREATE TABLE IF NOT EXISTS digital_twin_reconciliation (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES digital_twin_snapshots(id),
    issue_type TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digital_twin_drift (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES digital_twin_snapshots(id),
    drift_type TEXT NOT NULL,
    details TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engineering_scenarios (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES digital_twin_snapshots(id),
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    owner TEXT,
    purpose TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS scenario_changes (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    change_type TEXT NOT NULL,
    target TEXT,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_assumptions (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    assumption TEXT,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_propagation (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    node_id TEXT,
    depth INTEGER,
    affected_count INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_impacts (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    affected_projects TEXT,
    affected_environments TEXT,
    blast_radius REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_capacity (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    available_capacity REAL,
    reserved_capacity REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_economics (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    cost_estimate REAL,
    budget_impact REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_resilience (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    resilience_score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_policy_evaluations (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_governance_evaluations (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_safety_evaluations (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_predictions (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    category TEXT,
    confidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_results (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    result_type TEXT,
    value REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_comparisons (
    id TEXT PRIMARY KEY,
    scenario_a_id TEXT,
    scenario_b_id TEXT,
    dimensions TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_recommendations (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    recommendation TEXT,
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_incident_previews (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    description TEXT,
    is_preview INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_replays (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    fingerprint TEXT,
    divergent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_learning (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES engineering_scenarios(id),
    learning_type TEXT,
    data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_audit (
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

CREATE TABLE IF NOT EXISTS scenario_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_circuit_breakers (
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