-- Phase 60: Autonomous Engineering Fleet Orchestration, Workload Scheduling & Global Resource Arbitration

CREATE TABLE IF NOT EXISTS fleet_nodes_phase60 (
    id TEXT PRIMARY KEY,
    node_key TEXT NOT NULL UNIQUE,
    agent_id TEXT,
    environment_id TEXT,
    provider TEXT,
    region TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    health_state TEXT NOT NULL DEFAULT 'unknown',
    capacity INTEGER DEFAULT 0,
    available_capacity INTEGER DEFAULT 0,
    current_workloads INTEGER DEFAULT 0,
    capabilities TEXT,
    version TEXT,
    trust_level TEXT NOT NULL DEFAULT 'low',
    scheduling_eligibility TEXT NOT NULL DEFAULT 'unknown',
    last_seen TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workload_definitions_phase60 (
    id TEXT PRIMARY KEY,
    workload_key TEXT NOT NULL UNIQUE,
    objective_id TEXT,
    operation_id TEXT,
    workload_type TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    criticality TEXT NOT NULL DEFAULT 'low',
    required_capabilities TEXT,
    required_resources TEXT,
    target_environment TEXT,
    estimated_duration INTEGER,
    deadline TIMESTAMP,
    preemptible INTEGER NOT NULL DEFAULT 0,
    retry_policy TEXT,
    governance_state TEXT,
    safety_state TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduling_queues_phase60 (
    id TEXT PRIMARY KEY,
    queue_name TEXT NOT NULL UNIQUE,
    queue_class TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduling_entries_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    queue_id TEXT,
    priority_score REAL,
    fairness_score REAL,
    aging_score REAL,
    resource_fit REAL,
    deadline_pressure REAL,
    dependency_ready INTEGER NOT NULL DEFAULT 0,
    scheduling_state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workload_id) REFERENCES workload_definitions_phase60(id),
    FOREIGN KEY (queue_id) REFERENCES scheduling_queues_phase60(id)
);

CREATE TABLE IF NOT EXISTS resource_reservations_phase60 (
    id TEXT PRIMARY KEY,
    reservation_key TEXT NOT NULL UNIQUE,
    workload_id TEXT NOT NULL,
    node_id TEXT,
    resource_type TEXT,
    amount REAL,
    state TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    FOREIGN KEY (workload_id) REFERENCES workload_definitions_phase60(id),
    FOREIGN KEY (node_id) REFERENCES fleet_nodes_phase60(id)
);

CREATE TABLE IF NOT EXISTS agent_assignments_phase60 (
    id TEXT PRIMARY KEY,
    assignment_key TEXT NOT NULL UNIQUE,
    workload_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    assignment_score REAL,
    assignment_state TEXT NOT NULL DEFAULT 'assigned',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workload_id) REFERENCES workload_definitions_phase60(id),
    FOREIGN KEY (node_id) REFERENCES fleet_nodes_phase60(id)
);

CREATE TABLE IF NOT EXISTS scheduling_decisions_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    decision_fingerprint TEXT NOT NULL UNIQUE,
    selected_node_id TEXT,
    reasons TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workload_id) REFERENCES workload_definitions_phase60(id)
);

CREATE TABLE IF NOT EXISTS scheduling_conflicts_phase60 (
    id TEXT PRIMARY KEY,
    conflict_type TEXT NOT NULL,
    involved_workloads TEXT,
    details TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workload_preemptions_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    preemption_state TEXT NOT NULL DEFAULT 'requested',
    checkpoint_ref TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workload_reassignments_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    from_node_id TEXT,
    to_node_id TEXT,
    reason TEXT,
    reassignment_state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_incidents_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_evidence_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT,
    evidence_type TEXT NOT NULL,
    evidence TEXT,
    integrity_hash TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_audit_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_lineage_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL,
    objective_id TEXT,
    operation_id TEXT,
    scheduling_decision_id TEXT,
    assignment_id TEXT,
    reservation_id TEXT,
    execution_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduler_learning_phase60 (
    id TEXT PRIMARY KEY,
    workload_id TEXT,
    pattern TEXT,
    outcome TEXT,
    recommendation TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phase60_workloads_env ON workload_definitions_phase60(target_environment);
CREATE INDEX idx_phase60_nodes_env ON fleet_nodes_phase60(environment_id);
CREATE INDEX idx_phase60_assignments_workload ON agent_assignments_phase60(workload_id);
