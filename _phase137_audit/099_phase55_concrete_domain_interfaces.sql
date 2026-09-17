-- Phase 55: Concrete Domain Interfaces, Typed Engineering Contracts & Cross-Domain Execution Integration

CREATE TABLE IF NOT EXISTS domain_registry_phase55 (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    capabilities TEXT NOT NULL DEFAULT '[]',
    contract_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS domain_contracts_phase55 (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    contract_schema TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(domain, operation_type)
);

CREATE TABLE IF NOT EXISTS domain_operations_phase55 (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    request_id TEXT,
    correlation_id TEXT,
    causation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    actor TEXT,
    source TEXT,
    target TEXT,
    state TEXT NOT NULL DEFAULT 'CREATED',
    risk TEXT,
    confidence REAL,
    priority INTEGER,
    approval TEXT,
    safety TEXT,
    evidence TEXT,
    lineage TEXT,
    rollback TEXT,
    verification TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS domain_dependencies_phase55 (
    id TEXT PRIMARY KEY,
    source_domain TEXT NOT NULL,
    target_domain TEXT NOT NULL,
    relationship TEXT NOT NULL DEFAULT 'depends_on',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_domain, target_domain)
);

CREATE TABLE IF NOT EXISTS domain_approvals_phase55 (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    approver TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    scope TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    FOREIGN KEY (operation_id) REFERENCES domain_operations_phase55(operation_id)
);

CREATE TABLE IF NOT EXISTS domain_evidence_phase55 (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    source TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    integrity_hash TEXT,
    content TEXT,
    confidence REAL,
    FOREIGN KEY (operation_id) REFERENCES domain_operations_phase55(operation_id)
);

CREATE TABLE IF NOT EXISTS domain_audit_phase55 (
    id TEXT PRIMARY KEY,
    operation_id TEXT,
    domain TEXT,
    actor TEXT,
    action TEXT,
    before_state TEXT,
    after_state TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    result TEXT,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS domain_lineage_phase55 (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    parent_operation_id TEXT,
    root_operation_id TEXT,
    correlation_id TEXT,
    causation_id TEXT,
    source_domain TEXT,
    target_domain TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS domain_learning_phase55 (
    id TEXT PRIMARY KEY,
    operation_id TEXT,
    pattern_type TEXT NOT NULL,
    outcome TEXT,
    recommendation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase55_operations_domain ON domain_operations_phase55(domain);
CREATE INDEX idx_phase55_operations_state ON domain_operations_phase55(state);
