-- 077_phase31_autonomous_platform_fleet_orchestration.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase31_environments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    environment_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    provider TEXT NOT NULL,
    region TEXT NOT NULL,
    account TEXT NOT NULL,
    cluster TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    health_state TEXT NOT NULL,
    criticality TEXT NOT NULL,
    protection_level TEXT NOT NULL,
    production INTEGER NOT NULL,
    dr_relationship TEXT NOT NULL,
    configuration_fingerprint TEXT NOT NULL,
    version_fingerprint TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase31_fleets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fleet_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    fleet_type TEXT NOT NULL,
    environment_scope TEXT NOT NULL,
    member_resources TEXT NOT NULL,
    criticality TEXT NOT NULL,
    ownership TEXT NOT NULL,
    health TEXT NOT NULL,
    desired_state TEXT NOT NULL,
    observed_state TEXT NOT NULL,
    version TEXT NOT NULL,
    configuration_fingerprint TEXT NOT NULL,
    protection_state TEXT NOT NULL,
    operational_policy TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase31_fleet_rollout_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    fleet_id TEXT NOT NULL,
    target_environments TEXT NOT NULL,
    desired_version TEXT NOT NULL,
    desired_config TEXT NOT NULL,
    waves TEXT NOT NULL,
    health_gates TEXT NOT NULL,
    safety_gates TEXT NOT NULL,
    governance_requirements TEXT NOT NULL,
    rollback_strategy TEXT NOT NULL,
    blast_radius TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    risk TEXT NOT NULL,
    evidence_requirements TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase31_fleet_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase31_fleet_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    fleet_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase31_fleet_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    fleet_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase31_fleet_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

CREATE TABLE IF NOT EXISTS phase31_fleet_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    fleet_id TEXT NOT NULL,
    operation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase31_fleet_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_type TEXT NOT NULL,
    success INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
