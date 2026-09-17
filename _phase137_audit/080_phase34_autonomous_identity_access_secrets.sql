-- 080_phase34_autonomous_identity_access_secrets.sql
BEGIN;

CREATE TABLE IF NOT EXISTS phase34_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    environment TEXT NOT NULL,
    status TEXT NOT NULL,
    owner TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    fingerprint TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase34_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    protected INTEGER NOT NULL,
    privileged INTEGER NOT NULL,
    permissions TEXT NOT NULL,
    version INTEGER NOT NULL,
    risk TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase34_access_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    identity_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    action TEXT NOT NULL,
    environment TEXT NOT NULL,
    risk TEXT NOT NULL,
    policy_decision TEXT NOT NULL,
    approval_required INTEGER NOT NULL,
    approved INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase34_secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    secret_id TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    provider TEXT NOT NULL,
    environment TEXT NOT NULL,
    scope TEXT NOT NULL,
    rotation_policy TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    last_rotated_at TEXT,
    next_rotation_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase34_secret_rotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rotation_id TEXT NOT NULL UNIQUE,
    secret_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase34_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL UNIQUE,
    identity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase34_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id TEXT NOT NULL UNIQUE,
    identity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS phase34_audit (
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

CREATE TABLE IF NOT EXISTS phase34_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    identity_id TEXT NOT NULL,
    operation_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase34_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    success INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

COMMIT;
