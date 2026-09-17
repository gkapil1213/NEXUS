-- Phase 72: Global Production Reliability, Failover & Disaster Recovery Control Plane
-- SQLite-compatible version

BEGIN;

CREATE TABLE IF NOT EXISTS global_topology (
    id TEXT PRIMARY KEY,
    node_type TEXT NOT NULL CHECK (node_type IN ('global','region','cluster','fleet','worker','provider','project','environment','failure_domain')),
    parent_id TEXT REFERENCES global_topology(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    health_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (health_state IN ('HEALTHY','DEGRADED','UNKNOWN','FAILED','DRAINING','QUARANTINED')),
    lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_state IN ('ACTIVE','INACTIVE','DRAINING','FAILED','QUARANTINED')),
    capacity TEXT NOT NULL DEFAULT '{}',
    governance_state TEXT NOT NULL DEFAULT 'ALLOW',
    protection_level TEXT NOT NULL DEFAULT 'STANDARD',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (parent_id, name, node_type)
);

CREATE TABLE IF NOT EXISTS regions (
    id TEXT PRIMARY KEY REFERENCES global_topology(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    geography TEXT NOT NULL,
    availability_state TEXT NOT NULL DEFAULT 'ACTIVE',
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    capacity TEXT NOT NULL DEFAULT '{}',
    latency_metadata TEXT NOT NULL DEFAULT '{}',
    protection_level TEXT NOT NULL DEFAULT 'STANDARD',
    dr_role TEXT NOT NULL DEFAULT 'PRIMARY' CHECK (dr_role IN ('PRIMARY','SECONDARY','STANDBY','DRAINING','FAILED')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY REFERENCES global_topology(id) ON DELETE CASCADE,
    region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    environment TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    capacity TEXT NOT NULL DEFAULT '{}',
    concurrency INT NOT NULL DEFAULT 1,
    lifecycle TEXT NOT NULL DEFAULT 'ACTIVE',
    governance TEXT NOT NULL DEFAULT 'ALLOW',
    protection_level TEXT NOT NULL DEFAULT 'STANDARD',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failure_domains (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('worker','fleet','cluster','region','provider','project','environment')),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','DEGRADED','FAILED','QUARANTINED')),
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    UNIQUE (scope, entity_id)
);

CREATE TABLE IF NOT EXISTS topology_health (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    health_state TEXT NOT NULL CHECK (health_state IN ('HEALTHY','DEGRADED','UNKNOWN','FAILED','DRAINING','QUARANTINED')),
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    correlation_id TEXT NOT NULL,
    UNIQUE (entity_id, observed_at, source)
);

CREATE TABLE IF NOT EXISTS topology_capacity (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    total_capacity INT NOT NULL DEFAULT 0,
    available_capacity INT NOT NULL DEFAULT 0,
    reserved_capacity INT NOT NULL DEFAULT 0,
    active_capacity INT NOT NULL DEFAULT 0,
    utilization NUMERIC NOT NULL DEFAULT 0,
    concurrency INT NOT NULL DEFAULT 0,
    queued_workloads INT NOT NULL DEFAULT 0,
    provider_limits TEXT NOT NULL DEFAULT '{}',
    regional_limits TEXT NOT NULL DEFAULT '{}',
    cluster_limits TEXT NOT NULL DEFAULT '{}',
    project_limits TEXT NOT NULL DEFAULT '{}',
    environment_limits TEXT NOT NULL DEFAULT '{}',
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    UNIQUE (entity_id, observed_at)
);

CREATE TABLE IF NOT EXISTS disaster_recovery_policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    recovery_priority INT NOT NULL DEFAULT 100,
    recovery_objective TEXT NOT NULL,
    rpo_metadata TEXT NOT NULL DEFAULT '{}',
    rto_metadata TEXT NOT NULL DEFAULT '{}',
    dependency_order TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recovery_plans (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    affected_scope TEXT NOT NULL,
    workloads TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    source_domain TEXT NOT NULL,
    target_domain TEXT NOT NULL,
    required_capacity TEXT NOT NULL,
    required_approvals TEXT NOT NULL,
    required_safety_gates TEXT NOT NULL,
    rollback_path TEXT NOT NULL,
    verification_strategy TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','APPROVED','EXECUTING','COMPLETED','FAILED','ROLLED_BACK')),
    version INT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failover_operations (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES global_topology(id),
    target_id TEXT NOT NULL REFERENCES global_topology(id),
    state TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','RESERVED','APPROVED','EXECUTING','VERIFIED','COMPLETED','FAILED','ROLLED_BACK')),
    approval_id TEXT,
    reservation_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    failure_reason TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (plan_id, source_id, target_id, state)
);

CREATE TABLE IF NOT EXISTS failback_operations (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES global_topology(id),
    target_id TEXT NOT NULL REFERENCES global_topology(id),
    state TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','RESERVED','APPROVED','EXECUTING','VERIFIED','COMPLETED','FAILED','ROLLED_BACK')),
    approval_id TEXT,
    reservation_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    failure_reason TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workload_migrations (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    source_domain TEXT NOT NULL,
    target_domain TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','RESERVED','EXECUTING','VERIFIED','COMPLETED','FAILED','ROLLED_BACK')),
    idempotency_key TEXT NOT NULL,
    ownership TEXT NOT NULL,
    reservation_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    failure_reason TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (workload_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS recovery_reservations (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    capacity_reserved INT NOT NULL,
    operation_type TEXT NOT NULL CHECK (operation_type IN ('FAILOVER','FAILBACK','MIGRATION','RECOVERY')),
    operation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    UNIQUE (entity_id, operation_id)
);

CREATE TABLE IF NOT EXISTS consistency_conflicts (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    conflict_type TEXT NOT NULL CHECK (conflict_type IN ('STALE_STATE','CONFLICTING_STATE','DIVERGENT_STATE','MISSING_STATE','DUPLICATE_STATE','SPLIT_BRAIN','REPLAY_DIVERGENCE','TOPOLOGY_DIVERGENCE')),
    description TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS split_brain_events (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    description TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS control_plane_epochs (
    id TEXT PRIMARY KEY,
    controller_id TEXT NOT NULL,
    epoch INT NOT NULL,
    leadership_lease TEXT NOT NULL DEFAULT '{}',
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    fenced BOOLEAN NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS global_circuit_breakers (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('global','provider','region','cluster','fleet','project','environment')),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED','OPEN','HALF_OPEN')),
    opened_at TEXT,
    closed_at TEXT,
    failure_count INT NOT NULL DEFAULT 0,
    last_failure_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    UNIQUE (scope, entity_id)
);

CREATE TABLE IF NOT EXISTS topology_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    description TEXT NOT NULL,
    affected_scope TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved BOOLEAN NOT NULL DEFAULT 0,
    escalated BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topology_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topology_audit (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    control_plane_epoch INT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topology_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topology_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_global_topology_parent ON global_topology(parent_id);
CREATE INDEX IF NOT EXISTS idx_regions_provider ON regions(provider);
CREATE INDEX IF NOT EXISTS idx_clusters_region ON clusters(region_id);
CREATE INDEX IF NOT EXISTS idx_failure_domains_entity ON failure_domains(entity_id);
CREATE INDEX IF NOT EXISTS idx_topology_health_entity_time ON topology_health(entity_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_topology_capacity_entity_time ON topology_capacity(entity_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_plans_incident ON recovery_plans(incident_id);
CREATE INDEX IF NOT EXISTS idx_failover_operations_plan ON failover_operations(plan_id);
CREATE INDEX IF NOT EXISTS idx_workload_migrations_workload ON workload_migrations(workload_id);
CREATE INDEX IF NOT EXISTS idx_recovery_reservations_entity ON recovery_reservations(entity_id);
CREATE INDEX IF NOT EXISTS idx_global_circuit_breakers_scope ON global_circuit_breakers(scope, entity_id);


-- Seed global control plane root
INSERT OR IGNORE INTO global_topology (id, node_type, parent_id, name, health_state, lifecycle_state, capacity, governance_state, protection_level)
VALUES ('global', 'global', NULL, 'Global Control Plane', 'UNKNOWN', 'ACTIVE', '{}', 'ALLOW', 'STANDARD');


CREATE TABLE IF NOT EXISTS replay_fingerprints (
    decision_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
COMMIT;