-- 078_phase32_autonomous_governance_policy_compliance.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase32_governance_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL,
    scope TEXT NOT NULL,
    severity TEXT NOT NULL,
    priority INTEGER NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    expires_at TEXT,
    owner TEXT NOT NULL,
    control_mappings TEXT NOT NULL,
    conditions TEXT NOT NULL,
    actions TEXT NOT NULL,
    exceptions TEXT NOT NULL,
    approval_required INTEGER NOT NULL,
    enforcement_mode TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase32_policy_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id TEXT NOT NULL UNIQUE,
    policy_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    risk TEXT NOT NULL,
    approval_required INTEGER NOT NULL,
    exception_required INTEGER NOT NULL,
    matched_conditions TEXT NOT NULL,
    failed_conditions TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    fingerprint TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase32_policy_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    violation_id TEXT NOT NULL UNIQUE,
    policy_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    control_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    severity TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    first_detected TEXT NOT NULL,
    last_detected TEXT NOT NULL,
    owner TEXT NOT NULL,
    remediation_status TEXT NOT NULL,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase32_approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    approver_role TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    required_approvals INTEGER NOT NULL,
    current_approvals INTEGER NOT NULL,
    separation_of_duties INTEGER NOT NULL,
    requester_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase32_policy_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exception_id TEXT NOT NULL UNIQUE,
    policy_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    reason TEXT,
    requester_id TEXT NOT NULL,
    approver_id TEXT NOT NULL,
    start_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    risk_acceptance TEXT,
    compensating_control TEXT,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phase32_governance_remediation_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    violation_id TEXT NOT NULL,
    actions TEXT NOT NULL,
    risk TEXT NOT NULL,
    blast_radius TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase32_governance_remediation_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase32_governance_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    violation_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    risk TEXT NOT NULL,
    severity TEXT NOT NULL,
    blast_radius TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase32_governance_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    decision_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    resource_id TEXT NOT NULL,
    control_id TEXT NOT NULL,
    risk TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    exception_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase32_governance_audit (
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

CREATE TABLE IF NOT EXISTS phase32_governance_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    decision_id TEXT NOT NULL,
    operation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase32_governance_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL,
    expected_outcome TEXT NOT NULL,
    actual_outcome TEXT NOT NULL,
    policy_effectiveness TEXT,
    false_positive INTEGER NOT NULL,
    false_negative INTEGER NOT NULL,
    remediation_success INTEGER NOT NULL,
    rollback_success INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
