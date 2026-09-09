-- Phase 99: Autonomous Engineering Governance, Compliance & Human Oversight
-- Migration 141

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS governance_domains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS governance_policies_phase99 (
    id TEXT PRIMARY KEY,
    domain_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    policy_data TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT,
    expires_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (domain_id) REFERENCES governance_domains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS governance_policy_versions (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (policy_id) REFERENCES governance_policies_phase99(id) ON DELETE CASCADE,
    UNIQUE(policy_id, version)
);

CREATE TABLE IF NOT EXISTS governance_policy_bindings (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    binding_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (policy_id) REFERENCES governance_policies_phase99(id) ON DELETE CASCADE,
    UNIQUE(policy_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS governance_policy_conflicts (
    id TEXT PRIMARY KEY,
    policy_id_1 TEXT NOT NULL,
    policy_id_2 TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    resolution TEXT NOT NULL DEFAULT 'UNRESOLVED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (policy_id_1) REFERENCES governance_policies_phase99(id) ON DELETE CASCADE,
    FOREIGN KEY (policy_id_2) REFERENCES governance_policies_phase99(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS governance_decisions (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    action TEXT NOT NULL,
    scope TEXT NOT NULL,
    policy_versions TEXT NOT NULL DEFAULT '[]',
    controls_evaluated TEXT NOT NULL DEFAULT '[]',
    authorization TEXT NOT NULL DEFAULT 'UNKNOWN',
    compliance TEXT NOT NULL DEFAULT 'UNKNOWN',
    risk TEXT NOT NULL DEFAULT 'UNKNOWN',
    safety TEXT NOT NULL DEFAULT 'UNKNOWN',
    approval_requirement TEXT NOT NULL DEFAULT 'UNKNOWN',
    final_outcome TEXT NOT NULL,
    reasons TEXT NOT NULL DEFAULT '{}',
    evidence TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS governance_constraints (
    id TEXT PRIMARY KEY,
    domain_id TEXT NOT NULL,
    constraint_type TEXT NOT NULL,
    constraint_value TEXT NOT NULL,
    protected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (domain_id) REFERENCES governance_domains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS compliance_frameworks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS compliance_controls (
    id TEXT PRIMARY KEY,
    framework_id TEXT NOT NULL,
    control_id TEXT NOT NULL,
    description TEXT NOT NULL,
    requirement TEXT NOT NULL,
    evidence_required INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (framework_id) REFERENCES compliance_frameworks(id) ON DELETE CASCADE,
    UNIQUE(framework_id, control_id)
);

CREATE TABLE IF NOT EXISTS compliance_obligations (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    obligation_type TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (control_id) REFERENCES compliance_controls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS compliance_control_mappings (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (control_id) REFERENCES compliance_controls(id) ON DELETE CASCADE,
    UNIQUE(control_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS compliance_assessments (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    assessment_state TEXT NOT NULL,
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (control_id) REFERENCES compliance_controls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS compliance_findings (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL,
    finding_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (assessment_id) REFERENCES compliance_assessments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS compliance_evidence (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    source TEXT NOT NULL,
    collected_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (assessment_id) REFERENCES compliance_assessments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS compliance_exceptions (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    justification TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'UNKNOWN',
    compensating_control_id TEXT,
    approver TEXT,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    expires_at TEXT,
    approved_at TEXT,
    revoked_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (control_id) REFERENCES compliance_controls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS compensating_controls (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    effectiveness TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_waivers (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    justification TEXT NOT NULL,
    risk_acceptance TEXT NOT NULL,
    scope TEXT NOT NULL,
    approver TEXT,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    expires_at TEXT,
    approved_at TEXT,
    revoked_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS waiver_approvals (
    id TEXT PRIMARY KEY,
    waiver_id TEXT NOT NULL,
    approver TEXT NOT NULL,
    decision TEXT NOT NULL,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (waiver_id) REFERENCES governance_waivers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oversight_requests (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    requested_action TEXT NOT NULL,
    requester TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'REQUESTED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS oversight_approvals (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    approver TEXT NOT NULL,
    decision TEXT NOT NULL,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (request_id) REFERENCES oversight_requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oversight_approvers (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    approver_identity TEXT NOT NULL,
    FOREIGN KEY (request_id) REFERENCES oversight_requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oversight_quorums (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    quorum_size INTEGER NOT NULL,
    FOREIGN KEY (request_id) REFERENCES oversight_requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oversight_interventions (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    intervention_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (request_id) REFERENCES oversight_requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS authorization_grants (
    id TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    role TEXT,
    capability TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    effect TEXT NOT NULL DEFAULT 'ALLOW',
    expires_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS authorization_revocations (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    revoked_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (grant_id) REFERENCES authorization_grants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS separation_of_duties_rules (
    id TEXT PRIMARY KEY,
    rule_name TEXT NOT NULL,
    conflicting_roles TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS break_glass_events (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at TEXT,
    activated_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS protected_operations (
    id TEXT PRIMARY KEY,
    operation_name TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    approval_required INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_execution_gates (
    id TEXT PRIMARY KEY,
    gate_name TEXT NOT NULL,
    required_checks TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS compliance_execution_gates (
    id TEXT PRIMARY KEY,
    gate_name TEXT NOT NULL,
    required_controls TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_governance_profiles (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '[]',
    authorization_scope TEXT NOT NULL DEFAULT '{}',
    tools TEXT NOT NULL DEFAULT '[]',
    model_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_governance_records (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    version TEXT NOT NULL,
    provider TEXT,
    approval_status TEXT NOT NULL DEFAULT 'PENDING',
    safety_evaluation TEXT,
    capability_profile TEXT,
    tool_permissions TEXT DEFAULT '[]',
    data_permissions TEXT DEFAULT '[]',
    risk_classification TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_permission_policies (
    id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL,
    allowed_scopes TEXT NOT NULL DEFAULT '[]',
    restricted_scopes TEXT NOT NULL DEFAULT '[]',
    approval_required INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS data_governance_rules (
    id TEXT PRIMARY KEY,
    data_classification TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    allowed_regions TEXT NOT NULL DEFAULT '[]',
    prohibited_regions TEXT NOT NULL DEFAULT '[]',
    retention_days INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS residency_policies (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    allowed_regions TEXT NOT NULL,
    prohibited_regions TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS retention_policies (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    retention_days INTEGER NOT NULL,
    legal_hold INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supply_chain_findings (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    finding_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifact_governance_records (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    provenance_verified INTEGER NOT NULL DEFAULT 0,
    sbom TEXT,
    signature_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS release_governance_records (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    artifacts TEXT NOT NULL DEFAULT '[]',
    approvals TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS infrastructure_governance_records (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    action TEXT NOT NULL,
    approval_required INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_incidents (
    id TEXT PRIMARY KEY,
    incident_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_escalations (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (incident_id) REFERENCES governance_incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS corrective_actions (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    owner TEXT,
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preventive_actions (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    owner TEXT,
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_audit (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    actor TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'system',
    reason TEXT,
    policy_version TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    node_id TEXT NOT NULL,
    parent_node_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_learning (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    learning_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_replay (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    divergence INTEGER NOT NULL DEFAULT 0,
    replayed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_governance_policies_phase99_domain ON governance_policies_phase99(domain_id);
CREATE INDEX idx_compliance_controls_framework ON compliance_controls(framework_id);
CREATE INDEX idx_compliance_assessments_control ON compliance_assessments(control_id);
CREATE INDEX idx_authorization_grants_identity ON authorization_grants(identity);
