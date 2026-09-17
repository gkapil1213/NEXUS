-- Phase 54: Autonomous Multi-Agent Engineering Coordination & Agent Federation

CREATE TABLE IF NOT EXISTS agents_phase54 (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    health_state TEXT NOT NULL DEFAULT 'unknown',
    version TEXT,
    provider TEXT,
    capabilities TEXT,
    specialization TEXT,
    priority INTEGER DEFAULT 0,
    max_concurrency INTEGER DEFAULT 1,
    current_load INTEGER DEFAULT 0,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_capabilities_phase54 (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    proficiency REAL DEFAULT 0.5,
    enabled INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, capability),
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS agent_heartbeats_phase54 (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    heartbeat_id TEXT NOT NULL UNIQUE,
    observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    health TEXT,
    load INTEGER,
    metadata TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS engineering_tasks_phase54 (
    id TEXT PRIMARY KEY,
    task_key TEXT NOT NULL UNIQUE,
    parent_task_id TEXT,
    task_type TEXT NOT NULL,
    objective TEXT,
    priority INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    required_capabilities TEXT,
    constraints TEXT,
    context TEXT,
    deadline TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_dependencies_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    dependency_task_id TEXT NOT NULL,
    dependency_type TEXT NOT NULL DEFAULT 'requires',
    status TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(task_id, dependency_task_id),
    CHECK(task_id <> dependency_task_id),
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (dependency_task_id) REFERENCES engineering_tasks_phase54(id)
);

CREATE TABLE IF NOT EXISTS task_assignments_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    assignment_state TEXT NOT NULL DEFAULT 'assigned',
    assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMP,
    reason TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS agent_leases_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    lease_state TEXT NOT NULL DEFAULT 'active',
    acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    renewed_at TIMESTAMP,
    released_at TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS agent_handoffs_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    reason TEXT,
    context_snapshot TEXT,
    handoff_state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (from_agent_id) REFERENCES agents_phase54(id),
    FOREIGN KEY (to_agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS agent_messages_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    sender_agent_id TEXT,
    receiver_agent_id TEXT,
    message_type TEXT NOT NULL,
    payload TEXT,
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (sender_agent_id) REFERENCES agents_phase54(id),
    FOREIGN KEY (receiver_agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS agent_recommendations_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    recommendation_type TEXT NOT NULL,
    recommendation TEXT,
    confidence REAL,
    evidence TEXT,
    risk TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS agent_conflicts_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    participants TEXT,
    conflicting_recommendations TEXT,
    severity TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id)
);

CREATE TABLE IF NOT EXISTS agent_consensus_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    participants TEXT,
    votes TEXT,
    consensus_state TEXT NOT NULL DEFAULT 'pending',
    consensus_score REAL,
    decision TEXT,
    rationale TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id)
);

CREATE TABLE IF NOT EXISTS agent_arbitration_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    conflict_id TEXT,
    arbitration_method TEXT NOT NULL,
    inputs TEXT,
    outcome TEXT,
    rationale TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (conflict_id) REFERENCES agent_conflicts_phase54(id)
);

CREATE TABLE IF NOT EXISTS coordination_executions_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    attempt INTEGER DEFAULT 1,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error TEXT,
    result TEXT,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS coordination_incidents_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    agent_id TEXT,
    incident_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS coordination_evidence_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    agent_id TEXT,
    evidence_type TEXT NOT NULL,
    evidence TEXT,
    integrity_hash TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS coordination_audit_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    agent_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id),
    FOREIGN KEY (agent_id) REFERENCES agents_phase54(id)
);

CREATE TABLE IF NOT EXISTS coordination_lineage_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    parent_task_id TEXT,
    agent_id TEXT,
    assignment_id TEXT,
    lease_id TEXT,
    recommendation_id TEXT,
    consensus_id TEXT,
    execution_id TEXT,
    incident_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id)
);

CREATE TABLE IF NOT EXISTS coordination_learning_phase54 (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    outcome TEXT,
    coordination_pattern TEXT,
    agent_performance TEXT,
    routing_lesson TEXT,
    conflict_resolution_lesson TEXT,
    handoff_lesson TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES engineering_tasks_phase54(id)
);

CREATE INDEX idx_phase54_agents_key ON agents_phase54(agent_key);
CREATE INDEX idx_phase54_tasks_key ON engineering_tasks_phase54(task_key);
CREATE INDEX idx_phase54_assignments_task ON task_assignments_phase54(task_id);
CREATE INDEX idx_phase54_leases_task ON agent_leases_phase54(task_id);
