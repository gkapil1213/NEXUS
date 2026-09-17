-- Phase 73: Global Multi-Region Autonomous Control Plane & Active-Active Orchestration
-- SQLite-compatible

BEGIN;

CREATE TABLE IF NOT EXISTS regions (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    geography TEXT NOT NULL,
    control_plane_endpoint TEXT NOT NULL,
    execution_endpoint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    capacity INTEGER NOT NULL DEFAULT 0,
    latency_metadata TEXT NOT NULL DEFAULT '{}',
    availability_state TEXT NOT NULL DEFAULT 'ACTIVE',
    protection_level TEXT NOT NULL DEFAULT 'STANDARD',
    governance_state TEXT NOT NULL DEFAULT 'ALLOW',
    failure_domain TEXT NOT NULL,
    active_standby_capability TEXT NOT NULL DEFAULT 'ACTIVE',
    supported_environments TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS region_health (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    control_plane_health TEXT NOT NULL,
    worker_health TEXT NOT NULL,
    provider_health TEXT NOT NULL,
    network_health TEXT NOT NULL,
    storage_health TEXT NOT NULL,
    execution_health TEXT NOT NULL,
    dependency_health TEXT NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 0,
    active_workload_count INTEGER NOT NULL DEFAULT 0,
    queue_depth INTEGER NOT NULL DEFAULT 0,
    error_rate REAL NOT NULL DEFAULT 0,
    recovery_state TEXT NOT NULL DEFAULT 'NONE',
    circuit_breaker_state TEXT NOT NULL DEFAULT 'CLOSED',
    health_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    UNIQUE(region_id, observed_at)
);

CREATE TABLE IF NOT EXISTS control_plane_members (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL REFERENCES regions(id),
    instance_identity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'JOINING',
    epoch INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    capabilities TEXT NOT NULL DEFAULT '[]',
    fencing_state TEXT NOT NULL DEFAULT 'NONE',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(region_id, instance_identity)
);

CREATE TABLE IF NOT EXISTS coordinator_epochs (
    id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL,
    coordinator_id TEXT NOT NULL,
    lease_start TEXT NOT NULL DEFAULT (datetime('now')),
    lease_expires_at TEXT NOT NULL,
    fenced INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quorum_states (
    id TEXT PRIMARY KEY,
    total_members INTEGER NOT NULL,
    active_members INTEGER NOT NULL,
    required_quorum INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'UNKNOWN',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fencing_records (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    member_id TEXT,
    fence_reason TEXT NOT NULL,
    fence_epoch INTEGER NOT NULL,
    fence_state TEXT NOT NULL DEFAULT 'REQUESTED',
    fenced_at TEXT NOT NULL DEFAULT (datetime('now')),
    unfenced_at TEXT,
    verification_state TEXT,
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS region_capacities (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    total_capacity INTEGER NOT NULL,
    available_capacity INTEGER NOT NULL,
    reserved_capacity INTEGER NOT NULL,
    active_capacity INTEGER NOT NULL,
    utilization REAL NOT NULL DEFAULT 0,
    concurrency INTEGER NOT NULL DEFAULT 0,
    queue_depth INTEGER NOT NULL DEFAULT 0,
    provider_limits TEXT NOT NULL DEFAULT '{}',
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL,
    UNIQUE(region_id, observed_at)
);

CREATE TABLE IF NOT EXISTS global_placements (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    region_id TEXT NOT NULL,
    placement_state TEXT NOT NULL DEFAULT 'PLANNED',
    placement_epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS global_reservations (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    workload_id TEXT NOT NULL,
    reservation_state TEXT NOT NULL DEFAULT 'ACQUIRED',
    capacity_reserved INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(region_id, workload_id)
);

CREATE TABLE IF NOT EXISTS regional_failovers (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    source_region_id TEXT NOT NULL,
    target_region_id TEXT NOT NULL,
    failover_state TEXT NOT NULL DEFAULT 'PLANNED',
    failover_epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    verification_state TEXT
);

CREATE TABLE IF NOT EXISTS region_evacuations (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    evacuation_state TEXT NOT NULL DEFAULT 'REQUESTED',
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    dispatch_freeze INTEGER NOT NULL DEFAULT 0,
    verification_state TEXT
);

CREATE TABLE IF NOT EXISTS reconciliation_records (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    workload_id TEXT,
    conflict_type TEXT NOT NULL,
    description TEXT NOT NULL,
    reconciliation_decision TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    correlation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_consistency_checkpoints (
    id TEXT PRIMARY KEY,
    checkpoint_epoch INTEGER NOT NULL,
    data_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase73_incidents (
    id TEXT PRIMARY KEY,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    affected_region_id TEXT,
    incident_type TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0,
    escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS phase73_evidence (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase73_audit (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    region_id TEXT,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase73_lineage (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase73_learning (
    id TEXT PRIMARY KEY,
    learning_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_region_health_region ON region_health(region_id);
CREATE INDEX IF NOT EXISTS idx_members_region ON control_plane_members(region_id);
CREATE INDEX IF NOT EXISTS idx_placements_workload ON global_placements(workload_id);
CREATE INDEX IF NOT EXISTS idx_reservations_region ON global_reservations(region_id);
CREATE INDEX IF NOT EXISTS idx_failovers_workload ON regional_failovers(workload_id);
CREATE INDEX IF NOT EXISTS idx_incidents_region ON phase73_incidents(affected_region_id);

COMMIT;