-- 070_phase24_disaster_recovery_business_continuity.sql
BEGIN;

CREATE TABLE IF NOT EXISTS recovery_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    service TEXT NOT NULL,
    environment TEXT NOT NULL,
    strategy TEXT NOT NULL,
    rpo_seconds INTEGER NOT NULL,
    rto_seconds INTEGER NOT NULL,
    backup_requirements TEXT NOT NULL,
    restore_strategy TEXT,
    failover_strategy TEXT,
    failback_strategy TEXT,
    dependencies TEXT NOT NULL,
    required_approvals INTEGER NOT NULL,
    safety_requirements TEXT NOT NULL,
    verification_requirements TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS backup_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id TEXT NOT NULL UNIQUE,
    frequency_hours INTEGER NOT NULL,
    retention_days INTEGER NOT NULL,
    backup_type TEXT NOT NULL,
    required_verification INTEGER NOT NULL,
    encryption_required INTEGER NOT NULL,
    integrity_required INTEGER NOT NULL,
    geographic_redundancy INTEGER NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS backup_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    policy_id TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    provider TEXT NOT NULL,
    artifact_id TEXT,
    fingerprint TEXT NOT NULL UNIQUE,
    error_classification TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS backup_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL,
    checksum TEXT NOT NULL,
    size INTEGER NOT NULL,
    provider_reference TEXT NOT NULL,
    encryption_metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    lineage TEXT NOT NULL,
    retention_state TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS recovery_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    backup_artifact_id TEXT NOT NULL,
    verification_state TEXT NOT NULL,
    retention_state TEXT NOT NULL,
    recovery_readiness TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restore_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restore_id TEXT NOT NULL UNIQUE,
    recovery_point_id TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS failover_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    primary_target TEXT NOT NULL,
    secondary_target TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    ordering TEXT NOT NULL,
    health_requirements TEXT NOT NULL,
    governance_requirements TEXT NOT NULL,
    safety_requirements TEXT NOT NULL,
    approval_required INTEGER NOT NULL,
    failback_strategy TEXT,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS failover_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS failback_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    failback_id TEXT NOT NULL UNIQUE,
    failover_execution_id TEXT NOT NULL,
    primary_health TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS recovery_drills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drill_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    is_drill INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS recovery_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    affected_services TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS recovery_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    recovery_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

CREATE TABLE IF NOT EXISTS recovery_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    recovery_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS recovery_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    incident_id TEXT,
    recovery_decision TEXT,
    recovery_point_id TEXT,
    backup_artifact_id TEXT,
    restore_id TEXT,
    failover_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
