-- Phase 68: End-to-End Autonomous Engineering OS Integration, System Coherence & Production Execution

CREATE TABLE IF NOT EXISTS phase68_executions (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL UNIQUE,
    request_id TEXT,
    correlation_id TEXT,
    parent_execution_id TEXT,
    environment_id TEXT,
    release_id TEXT,
    deployment_id TEXT,
    policy_decision_id TEXT,
    evidence_id TEXT,
    state TEXT NOT NULL DEFAULT 'CREATED',
    final_outcome TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase68_lifecycle_transitions (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT,
    transition_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES phase68_executions(id)
);

CREATE TABLE IF NOT EXISTS phase68_integration_decisions (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES phase68_executions(id)
);

CREATE TABLE IF NOT EXISTS phase68_execution_checkpoints (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    checkpoint_type TEXT NOT NULL,
    checkpoint_state TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES phase68_executions(id)
);

CREATE TABLE IF NOT EXISTS phase68_verification_results (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    verification_type TEXT NOT NULL,
    verification_result TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES phase68_executions(id)
);

CREATE TABLE IF NOT EXISTS phase68_recovery_records (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    recovery_type TEXT NOT NULL,
    recovery_state TEXT NOT NULL DEFAULT 'DETECTED',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (execution_id) REFERENCES phase68_executions(id)
);

CREATE INDEX idx_phase68_executions_state ON phase68_executions(state);
CREATE INDEX idx_phase68_executions_correlation ON phase68_executions(correlation_id);
