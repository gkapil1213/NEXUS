-- Phase 53: Autonomous Engineering Knowledge & Organizational Memory

CREATE TABLE IF NOT EXISTS engineering_knowledge_phase53 (
    id TEXT PRIMARY KEY,
    knowledge_type TEXT NOT NULL,
    title TEXT,
    domain TEXT,
    environment TEXT,
    service_id TEXT,
    resource_id TEXT,
    provider TEXT,
    incident_id TEXT,
    decision_id TEXT,
    execution_id TEXT,
    source_event TEXT,
    source_evidence TEXT,
    observed_outcome TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    reliability REAL NOT NULL DEFAULT 0,
    freshness_state TEXT NOT NULL DEFAULT 'fresh',
    validity_state TEXT NOT NULL DEFAULT 'proposed',
    verification_state TEXT NOT NULL DEFAULT 'unverified',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_verified_at TIMESTAMP,
    expiration TIMESTAMP,
    contradiction_ref TEXT,
    superseded_by TEXT,
    fingerprint TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS knowledge_sources_phase53 (
    id TEXT PRIMARY KEY,
    knowledge_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    source_timestamp TIMESTAMP,
    provenance TEXT,
    lineage_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE TABLE IF NOT EXISTS knowledge_fingerprints_phase53 (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    knowledge_id TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE TABLE IF NOT EXISTS knowledge_precedents_phase53 (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    knowledge_id TEXT NOT NULL,
    similarity_score REAL,
    relevance TEXT,
    attached_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE TABLE IF NOT EXISTS knowledge_contradictions_phase53 (
    id TEXT PRIMARY KEY,
    original_knowledge_id TEXT NOT NULL,
    contradicting_knowledge_id TEXT NOT NULL,
    reason TEXT,
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (original_knowledge_id) REFERENCES engineering_knowledge_phase53(id),
    FOREIGN KEY (contradicting_knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE TABLE IF NOT EXISTS knowledge_supersessions_phase53 (
    id TEXT PRIMARY KEY,
    old_knowledge_id TEXT NOT NULL,
    new_knowledge_id TEXT NOT NULL,
    reason TEXT,
    superseded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (old_knowledge_id) REFERENCES engineering_knowledge_phase53(id),
    FOREIGN KEY (new_knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE TABLE IF NOT EXISTS knowledge_validations_phase53 (
    id TEXT PRIMARY KEY,
    knowledge_id TEXT NOT NULL,
    validation_state TEXT NOT NULL DEFAULT 'pending',
    validator TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE TABLE IF NOT EXISTS knowledge_governance_phase53 (
    id TEXT PRIMARY KEY,
    knowledge_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE TABLE IF NOT EXISTS knowledge_audit_phase53 (
    id TEXT PRIMARY KEY,
    knowledge_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge_lineage_phase53 (
    id TEXT PRIMARY KEY,
    source_event_id TEXT,
    knowledge_id TEXT NOT NULL,
    decision_id TEXT,
    execution_id TEXT,
    outcome_id TEXT,
    learning_outcome_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE TABLE IF NOT EXISTS knowledge_learning_phase53 (
    id TEXT PRIMARY KEY,
    knowledge_id TEXT NOT NULL,
    lesson TEXT,
    outcome TEXT,
    confidence REAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (knowledge_id) REFERENCES engineering_knowledge_phase53(id)
);

CREATE INDEX idx_phase53_knowledge_fingerprint ON engineering_knowledge_phase53(fingerprint);
CREATE INDEX idx_phase53_knowledge_type ON engineering_knowledge_phase53(knowledge_type);
CREATE INDEX idx_phase53_sources_knowledge ON knowledge_sources_phase53(knowledge_id);
CREATE INDEX idx_phase53_precedents_decision ON knowledge_precedents_phase53(decision_id);
