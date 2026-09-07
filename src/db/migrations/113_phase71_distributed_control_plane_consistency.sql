-- Phase 71: Distributed Control-Plane Consistency and Orchestration Reliability

CREATE TABLE IF NOT EXISTS phase71_instances (
  instance_id TEXT PRIMARY KEY,
  node_identity TEXT NOT NULL,
  software_version TEXT NOT NULL,
  capabilities_json TEXT,
  lifecycle_state TEXT NOT NULL,
  health_state TEXT NOT NULL,
  leadership_state TEXT NOT NULL,
  current_epoch_id TEXT,
  current_fencing_token TEXT,
  last_heartbeat_at INTEGER,
  registered_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS phase71_epochs (
  epoch_id TEXT PRIMARY KEY,
  term INTEGER NOT NULL UNIQUE,
  instance_id TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  fenced INTEGER NOT NULL DEFAULT 0,
  quorum_state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phase71_leadership_leases (
  lease_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  state TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER,
  released_at INTEGER,
  UNIQUE(instance_id, epoch_id)
);

CREATE TABLE IF NOT EXISTS phase71_fencing_tokens (
  token_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  token_value TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS phase71_workload_ownership (
  workload_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  state TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workload_id, instance_id)
);

CREATE TABLE IF NOT EXISTS phase71_quorum_states (
  quorum_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  status TEXT NOT NULL,
  total_instances INTEGER NOT NULL,
  active_instances INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase71_conflicts (
  conflict_id TEXT PRIMARY KEY,
  conflict_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  instance_id_a TEXT,
  instance_id_b TEXT,
  epoch_id_a TEXT,
  epoch_id_b TEXT,
  token_a TEXT,
  token_b TEXT,
  resolution TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase71_circuit_breakers (
  breaker_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  state TEXT NOT NULL,
  opened_at INTEGER,
  half_open_at INTEGER,
  closed_at INTEGER,
  reason TEXT,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase71_incidents (
  incident_id TEXT PRIMARY KEY,
  incident_type TEXT NOT NULL,
  entity_id TEXT,
  instance_id TEXT,
  epoch_id TEXT,
  fencing_token TEXT,
  description TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase71_evidence (
  evidence_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase71_audit (
  audit_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  entity TEXT NOT NULL,
  actor TEXT,
  instance_id TEXT,
  epoch_id TEXT,
  fencing_token TEXT,
  prev_state TEXT,
  new_state TEXT,
  reason TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase71_lineage (
  lineage_id TEXT PRIMARY KEY,
  root_type TEXT NOT NULL,
  root_id TEXT NOT NULL,
  chain_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase71_learning (
  learning_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_phase71_instances_health ON phase71_instances(health_state);
CREATE INDEX IF NOT EXISTS idx_phase71_instances_leadership ON phase71_instances(leadership_state);
CREATE INDEX IF NOT EXISTS idx_phase71_epochs_term ON phase71_epochs(term);
CREATE INDEX IF NOT EXISTS idx_phase71_leadership_expires ON phase71_leadership_leases(expires_at);
CREATE INDEX IF NOT EXISTS idx_phase71_workload_owner ON phase71_workload_ownership(instance_id);
CREATE INDEX IF NOT EXISTS idx_phase71_conflicts_type ON phase71_conflicts(conflict_type);
CREATE INDEX IF NOT EXISTS idx_phase71_incidents_type ON phase71_incidents(incident_type);
