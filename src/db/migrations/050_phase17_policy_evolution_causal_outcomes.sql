-- 050_phase17_policy_evolution_causal_outcomes.sql

BEGIN;

-- Policy evolution contexts
CREATE TABLE IF NOT EXISTS policy_evolution_contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    parent_version TEXT NOT NULL,
    proposed_version TEXT NOT NULL,
    decision_id TEXT,
    learning_cycle_id TEXT,
    correlation_id TEXT,
    worker_scope TEXT,
    evidence_references TEXT,           -- JSON array of evidence IDs
    baseline_period_start TEXT,
    baseline_period_end TEXT,
    treatment_period_start TEXT,
    treatment_period_end TEXT,
    control_period_start TEXT,
    control_period_end TEXT,
    expected_outcome TEXT,
    actual_outcome TEXT,
    confidence TEXT NOT NULL,
    risk TEXT NOT NULL,
    governance_state TEXT NOT NULL DEFAULT 'PENDING',
    safety_state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, policy_id, parent_version, proposed_version, correlation_id)
);

-- Policy outcome attribution
CREATE TABLE IF NOT EXISTS policy_outcome_attributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    correlation_id TEXT,
    attribution_status TEXT NOT NULL,   -- CAUSALLY_SUPPORTED, CORRELATED, CONFOUNDED, UNKNOWN, INSUFFICIENT_DATA
    confidence TEXT NOT NULL,
    confounders TEXT,                   -- JSON array
    supporting_evidence TEXT,           -- JSON array
    contradicting_evidence TEXT,        -- JSON array
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, policy_id, policy_version, correlation_id)
);

-- Policy evolution proposals
CREATE TABLE IF NOT EXISTS policy_evolution_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    proposed_version TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence_ids TEXT,                  -- JSON array
    expected_improvement TEXT,
    expected_risk TEXT NOT NULL,
    expected_cost_impact TEXT,
    expected_reliability_impact TEXT,
    confidence TEXT NOT NULL,
    rollback_plan TEXT,
    rollout_plan TEXT,
    expiry TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Policy evolution decisions (governance, safety, arbitration, conflict results)
CREATE TABLE IF NOT EXISTS policy_evolution_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    correlation_id TEXT,
    decision_type TEXT NOT NULL,        -- GOVERNANCE, SAFETY, ARBITRATION, CONFLICT
    decision_result TEXT NOT NULL,      -- ALLOW, DENY, DEFER, CONFLICTED, OBSERVE_ONLY, etc.
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, policy_id, policy_version, decision_type, correlation_id)
);

-- Policy lineage
CREATE TABLE IF NOT EXISTS policy_lineage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    version TEXT NOT NULL,
    parent_version TEXT,
    reason TEXT,
    evidence_ids TEXT,                  -- JSON array
    proposal_id TEXT,
    authorization_id TEXT,
    rollout_id TEXT,
    outcome TEXT,
    status TEXT NOT NULL,               -- PROPOSED, ACTIVE, SUPERSEDED, ROLLED_BACK, REJECTED
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, policy_id, version)
);

-- Policy promotion records
CREATE TABLE IF NOT EXISTS policy_promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    verification_result TEXT,
    confidence TEXT,
    decision TEXT NOT NULL,             -- PROMOTED, DENIED, DEFERRED
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    UNIQUE(tenant_id, policy_id, policy_version, correlation_id)
);

-- Policy evolution rollbacks
CREATE TABLE IF NOT EXISTS policy_evolution_rollbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    previous_known_good_version TEXT NOT NULL,
    trigger TEXT NOT NULL,
    decision TEXT NOT NULL,             -- ALLOWED, DENIED, DEFERRED
    executed_at TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, policy_id, policy_version, correlation_id)
);

-- Policy evolution audit events
CREATE TABLE IF NOT EXISTS policy_evolution_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    result TEXT,
    reason TEXT,
    redacted_metadata TEXT,             -- JSON
    UNIQUE(tenant_id, correlation_id, event_type, timestamp)
);

COMMIT;
