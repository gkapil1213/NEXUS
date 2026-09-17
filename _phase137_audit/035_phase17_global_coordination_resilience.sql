-- Phase 17.14: Autonomous Multi-Worker Coordination, Global Optimization & Control-Plane Resilience
CREATE TABLE IF NOT EXISTS worker_global_state (
  state_id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_coordination_plans (
  plan_id TEXT PRIMARY KEY,
  correlation_id TEXT,
  objective TEXT,
  policy_version INTEGER,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_control_epochs (
  epoch_id TEXT PRIMARY KEY,
  policy_version INTEGER,
  state_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  invalidated INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS worker_control_conflicts (
  conflict_id TEXT PRIMARY KEY,
  action_a TEXT NOT NULL,
  action_b TEXT NOT NULL,
  resolution TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_control_health (
  health_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_migrations (
  migration_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_worker_id TEXT NOT NULL,
  destination_worker_id TEXT,
  status TEXT NOT NULL,
  reservation_id TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
);

CREATE TABLE IF NOT EXISTS worker_control_transactions (
  transaction_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_global_state_created ON worker_global_state(created_at);
CREATE INDEX IF NOT EXISTS idx_coordination_plan_status ON worker_coordination_plans(state);
CREATE INDEX IF NOT EXISTS idx_control_epoch_expires ON worker_control_epochs(expires_at);
CREATE INDEX IF NOT EXISTS idx_control_health_created ON worker_control_health(created_at);
CREATE INDEX IF NOT EXISTS idx_migrations_job ON worker_migrations(job_id);
