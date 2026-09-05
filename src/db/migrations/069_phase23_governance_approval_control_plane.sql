-- 069_phase23_governance_approval_control_plane.sql

BEGIN;

CREATE TABLE IF NOT EXISTS governance_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    risk_threshold TEXT NOT NULL,
    auto_approve_below TEXT NOT NULL,
    require_separation_of_duties INTEGER NOT NULL,
    min_approvals INTEGER NOT NULL,
    emergency_allowed INTEGER NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS governance_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    risk_level TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_request_id TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    policy_fingerprint TEXT NOT NULL,
    required_approvals INTEGER NOT NULL,
    min_approvers INTEGER NOT NULL,
    separate_duties INTEGER NOT NULL,
    requester_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    approvals TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS approval_revocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revocation_id TEXT NOT NULL UNIQUE,
    approval_request_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emergency_authorizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emergency_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    role TEXT NOT NULL,
    reason TEXT,
    scope TEXT,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS governance_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    policy_fingerprint TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    risk_decision TEXT NOT NULL,
    approval_state TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    emergency INTEGER NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    decision TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    redacted_metadata TEXT
);

COMMIT;
