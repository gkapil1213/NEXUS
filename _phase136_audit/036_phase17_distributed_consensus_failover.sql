-- Phase 17.15: Distributed Control-Plane Consensus, Global Scheduling & Autonomous Coordinator Failover
CREATE TABLE IF NOT EXISTS coordinator_registry (
  coordinator_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  region TEXT,
  zone TEXT,
  environment TEXT,
  last_heartbeat_at INTEGER,
  current_epoch TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane_leadership (
  term_id TEXT PRIMARY KEY,
  coordinator_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  quorum_status TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(epoch_id)
);

CREATE TABLE IF NOT EXISTS control_plane_epochs (
  epoch_id TEXT PRIMARY KEY,
  term INTEGER NOT NULL,
  coordinator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  fenced INTEGER DEFAULT 0,
  UNIQUE(term)
);

CREATE TABLE IF NOT EXISTS control_plane_membership (
  membership_id TEXT PRIMARY KEY,
  coordinator_id TEXT NOT NULL,
  state TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS global_job_ownership (
  ownership_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  attempt_id TEXT,
  lease_id TEXT,
  dispatch_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_registry_state ON coordinator_registry(state);
CREATE INDEX IF NOT EXISTS idx_leadership_epoch ON control_plane_leadership(epoch_id);
CREATE INDEX IF NOT EXISTS idx_control_epochs_fenced ON control_plane_epochs(fenced);
CREATE INDEX IF NOT EXISTS idx_job_ownership_job ON global_job_ownership(job_id);
