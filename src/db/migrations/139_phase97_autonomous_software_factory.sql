-- Phase 97: Autonomous Software Factory
-- Migration 139

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS software_factories (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'INTAKE',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS software_products (
    id TEXT PRIMARY KEY,
    factory_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    portfolio_id TEXT,
    program_id TEXT,
    project_id TEXT,
    repository_id TEXT,
    environments TEXT NOT NULL DEFAULT '[]',
    technology_stack TEXT NOT NULL DEFAULT '{}',
    ownership TEXT NOT NULL DEFAULT '{}',
    lifecycle_state TEXT NOT NULL DEFAULT 'INTAKE',
    risk_classification TEXT NOT NULL DEFAULT 'UNKNOWN',
    governance_policy TEXT NOT NULL DEFAULT '{}',
    security_policy TEXT NOT NULL DEFAULT '{}',
    deployment_policy TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (factory_id) REFERENCES software_factories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_versions (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL DEFAULT 'system',
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE,
    UNIQUE(product_id, version)
);

CREATE TABLE IF NOT EXISTS software_repositories (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    protected_branches TEXT NOT NULL DEFAULT '[]',
    ownership TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'REGISTERED',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS repository_versions (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (repository_id) REFERENCES software_repositories(id) ON DELETE CASCADE,
    UNIQUE(repository_id, version)
);

CREATE TABLE IF NOT EXISTS repository_bindings (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (repository_id) REFERENCES software_repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS software_branches (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_protected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (repository_id) REFERENCES software_repositories(id) ON DELETE CASCADE,
    UNIQUE(repository_id, name)
);

CREATE TABLE IF NOT EXISTS engineering_changes (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    mission_id TEXT,
    requirement_id TEXT,
    architecture_version_id TEXT,
    implementation_plan_id TEXT,
    author_agent_id TEXT,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    risk TEXT NOT NULL DEFAULT 'UNKNOWN',
    blast_radius TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE,
    FOREIGN KEY (repository_id) REFERENCES software_repositories(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES software_branches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS change_versions (
    id TEXT PRIMARY KEY,
    change_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (change_id) REFERENCES engineering_changes(id) ON DELETE CASCADE,
    UNIQUE(change_id, version)
);

CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    requirement_type TEXT NOT NULL,
    description TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    constraints TEXT NOT NULL DEFAULT '[]',
    dependencies TEXT NOT NULL DEFAULT '[]',
    is_ambiguous INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requirement_versions (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
    UNIQUE(requirement_id, version)
);

CREATE TABLE IF NOT EXISTS architecture_artifacts (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    architecture_type TEXT NOT NULL,
    content TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT,
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS architecture_versions (
    id TEXT PRIMARY KEY,
    architecture_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (architecture_id) REFERENCES architecture_artifacts(id) ON DELETE CASCADE,
    UNIQUE(architecture_id, version)
);

CREATE TABLE IF NOT EXISTS technical_designs (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    design_type TEXT NOT NULL,
    content TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS design_versions (
    id TEXT PRIMARY KEY,
    design_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (design_id) REFERENCES technical_designs(id) ON DELETE CASCADE,
    UNIQUE(design_id, version)
);

CREATE TABLE IF NOT EXISTS implementation_plans (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    plan_data TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT,
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS implementation_steps (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    dependencies TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (plan_id) REFERENCES implementation_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS code_changes (
    id TEXT PRIMARY KEY,
    change_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    change_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (change_id) REFERENCES engineering_changes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS code_change_files (
    id TEXT PRIMARY KEY,
    code_change_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    operation TEXT NOT NULL,
    content TEXT NOT NULL,
    checksum TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (code_change_id) REFERENCES code_changes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS code_change_reviews (
    id TEXT PRIMARY KEY,
    change_id TEXT NOT NULL,
    reviewer_agent_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    findings TEXT NOT NULL DEFAULT '[]',
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (change_id) REFERENCES engineering_changes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    FOREIGN KEY (review_id) REFERENCES code_change_reviews(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_decisions (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT,
    decided_by TEXT NOT NULL,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (review_id) REFERENCES code_change_reviews(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_plans (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    plan_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_suites (
    id TEXT PRIMARY KEY,
    test_plan_id TEXT NOT NULL,
    name TEXT NOT NULL,
    suite_type TEXT NOT NULL,
    FOREIGN KEY (test_plan_id) REFERENCES test_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_executions (
    id TEXT PRIMARY KEY,
    suite_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    artifact_id TEXT,
    runner TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    evidence TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (suite_id) REFERENCES test_suites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_results (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    test_name TEXT NOT NULL,
    status TEXT NOT NULL,
    details TEXT,
    FOREIGN KEY (execution_id) REFERENCES test_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS build_plans (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    plan_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS build_executions (
    id TEXT PRIMARY KEY,
    build_plan_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    build_environment TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    logs TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (build_plan_id) REFERENCES build_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS build_artifacts (
    id TEXT PRIMARY KEY,
    build_execution_id TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    checksum TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (build_execution_id) REFERENCES build_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifact_manifests (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    manifest_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (artifact_id) REFERENCES build_artifacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifact_provenance (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    source_commit_hash TEXT NOT NULL,
    build_execution_id TEXT NOT NULL,
    dependency_manifest TEXT NOT NULL DEFAULT '{}',
    creator TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (artifact_id) REFERENCES build_artifacts(id) ON DELETE CASCADE,
    FOREIGN KEY (build_execution_id) REFERENCES build_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS security_scans (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    scan_type TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    findings TEXT NOT NULL DEFAULT '[]',
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS security_findings (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'OPEN',
    FOREIGN KEY (scan_id) REFERENCES security_scans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_gates (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    gate_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_gate_results (
    id TEXT PRIMARY KEY,
    gate_id TEXT NOT NULL,
    change_id TEXT,
    release_candidate_id TEXT,
    result TEXT NOT NULL DEFAULT 'UNKNOWN',
    details TEXT NOT NULL DEFAULT '{}',
    evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (gate_id) REFERENCES quality_gates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release_candidates (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    source_commit_hash TEXT NOT NULL,
    build_execution_id TEXT NOT NULL,
    artifacts TEXT NOT NULL DEFAULT '[]',
    test_results TEXT NOT NULL DEFAULT '[]',
    security_results TEXT NOT NULL DEFAULT '[]',
    quality_gate_results TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at TEXT,
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE,
    FOREIGN KEY (build_execution_id) REFERENCES build_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release_versions (
    id TEXT PRIMARY KEY,
    release_candidate_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (release_candidate_id) REFERENCES release_candidates(id) ON DELETE CASCADE,
    UNIQUE(release_candidate_id, version)
);

CREATE TABLE IF NOT EXISTS release_approvals (
    id TEXT PRIMARY KEY,
    release_candidate_id TEXT NOT NULL,
    approver TEXT NOT NULL,
    decision TEXT NOT NULL,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    policy_context TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (release_candidate_id) REFERENCES release_candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_plans (
    id TEXT PRIMARY KEY,
    release_candidate_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    strategy TEXT NOT NULL,
    plan_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (release_candidate_id) REFERENCES release_candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_executions (
    id TEXT PRIMARY KEY,
    deployment_plan_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (deployment_plan_id) REFERENCES deployment_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_targets (
    id TEXT PRIMARY KEY,
    deployment_execution_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    health_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    FOREIGN KEY (deployment_execution_id) REFERENCES deployment_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_verifications (
    id TEXT PRIMARY KEY,
    deployment_execution_id TEXT NOT NULL,
    verification_type TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}',
    verified_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (deployment_execution_id) REFERENCES deployment_executions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS factory_checkpoints (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    checkpoint_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS factory_failures (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    failure_type TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS factory_recoveries (
    id TEXT PRIMARY KEY,
    failure_id TEXT NOT NULL,
    recovery_plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    executed_at TEXT,
    verified_at TEXT,
    FOREIGN KEY (failure_id) REFERENCES factory_failures(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS factory_rollbacks (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    rollback_plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    executed_at TEXT,
    verified_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS factory_regressions (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    detection_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}',
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS factory_incidents (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_escalations (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (incident_id) REFERENCES factory_incidents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS factory_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    opened_at TEXT,
    half_open_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS factory_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_audit (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    actor TEXT NOT NULL,
    reason TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_lineage (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    node_id TEXT NOT NULL,
    parent_node_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS factory_learning (
    id TEXT PRIMARY KEY,
    product_id TEXT,
    learning_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS factory_replay (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    divergence INTEGER NOT NULL DEFAULT 0,
    replayed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES software_products(id) ON DELETE CASCADE
);

CREATE INDEX idx_products_factory ON software_products(factory_id);
CREATE INDEX idx_products_org ON software_products(organization_id);
CREATE INDEX idx_repos_product ON software_repositories(product_id);
CREATE INDEX idx_changes_product ON engineering_changes(product_id);
CREATE INDEX idx_requirements_product ON requirements(product_id);
CREATE INDEX idx_test_executions_suite ON test_executions(suite_id);
CREATE INDEX idx_build_executions_plan ON build_executions(build_plan_id);
CREATE INDEX idx_release_candidates_product ON release_candidates(product_id);
CREATE INDEX idx_deployment_executions_plan ON deployment_executions(deployment_plan_id);
