-- Phase 82: Autonomous Engineering Knowledge Graph, Causal Intelligence & Decision Memory
BEGIN;

CREATE TABLE IF NOT EXISTS knowledge_nodes (
    id TEXT PRIMARY KEY,
    node_type TEXT NOT NULL,
    project_id TEXT,
    environment TEXT,
    fleet_id TEXT,
    region_id TEXT,
    identifier TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(node_type, identifier)
);

CREATE TABLE IF NOT EXISTS knowledge_relationships (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
    target_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
    relationship_type TEXT NOT NULL,
    confidence REAL,
    provenance TEXT,
    evidence_ref TEXT,
    valid_from TEXT,
    valid_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, target_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_identifier TEXT,
    authority TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_conflicts (
    id TEXT PRIMARY KEY,
    node_a_id TEXT,
    node_b_id TEXT,
    conflict_type TEXT,
    description TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_causal_claims (
    id TEXT PRIMARY KEY,
    cause_id TEXT NOT NULL,
    effect_id TEXT NOT NULL,
    claim_type TEXT NOT NULL CHECK (claim_type IN ('OBSERVED','CORRELATED','PRECEDING','CONTRIBUTING','CAUSAL','UNKNOWN')),
    confidence REAL,
    evidence_ref TEXT,
    analysis_method TEXT,
    scope TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_causal_evidence (
    id TEXT PRIMARY KEY,
    causal_claim_id TEXT NOT NULL REFERENCES knowledge_causal_claims(id),
    evidence_type TEXT,
    evidence_ref TEXT,
    support_strength REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_snapshots (
    id TEXT PRIMARY KEY,
    snapshot_scope TEXT,
    graph_version INTEGER,
    integrity_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_reconciliation (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    issue_type TEXT,
    description TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_memory (
    id TEXT PRIMARY KEY,
    decision_type TEXT NOT NULL,
    input_state TEXT,
    evidence TEXT,
    selected_action TEXT,
    rejected_alternatives TEXT,
    constraints TEXT,
    policy_version TEXT,
    confidence REAL,
    outcome TEXT,
    provenance TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_alternatives (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decision_memory(id),
    alternative_action TEXT,
    rejected_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_evidence (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decision_memory(id),
    evidence_type TEXT,
    evidence_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_outcomes (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decision_memory(id),
    outcome_type TEXT,
    observed_value REAL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incident_similarity (
    id TEXT PRIMARY KEY,
    source_incident_id TEXT,
    similar_incident_id TEXT,
    similarity_score REAL,
    matched_attributes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS remediation_memory (
    id TEXT PRIMARY KEY,
    incident_type TEXT,
    remediation_action TEXT,
    outcome TEXT,
    success INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_type ON knowledge_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_rels_source ON knowledge_relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_rels_target ON knowledge_relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_causal_cause ON knowledge_causal_claims(cause_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_causal_effect ON knowledge_causal_claims(effect_id);
CREATE INDEX IF NOT EXISTS idx_decision_memory_type ON decision_memory(decision_type);

COMMIT;