-- Phase 57: Autonomous Engineering Control Loop, Goal Execution & Closed-Loop Recovery
CREATE TABLE IF NOT EXISTS objectives_phase57 (
    id TEXT PRIMARY KEY,
    objective_key TEXT NOT NULL UNIQUE,
    objective_type TEXT NOT NULL,
    description TEXT,
    requester TEXT,
    priority INTEGER DEFAULT 0,
    constraints TEXT,
    risk_tolerance TEXT,
    allowed_domains TEXT,
    prohibited_domains TEXT,
    state TEXT NOT NULL DEFAULT 'CREATED',
    completion_criteria TEXT,
    iteration INTEGER DEFAULT 0,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS plans_phase57 (
    id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL,
    steps_json TEXT,
    required_domains TEXT,
    required_capabilities TEXT,
    risk TEXT,
    blast_radius TEXT,
    rollback_strategy TEXT,
    verification_strategy TEXT,
    approval_requirements TEXT,
    version INTEGER DEFAULT 1,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS controller_decisions_phase57 (
    id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    evidence TEXT,
    audit TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_phase57_objectives_state ON objectives_phase57(state);
CREATE INDEX idx_phase57_plans_objective ON plans_phase57(objective_id);
