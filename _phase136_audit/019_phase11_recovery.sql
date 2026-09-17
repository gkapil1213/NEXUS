-- Phase 11: Recovery tables
CREATE TABLE IF NOT EXISTS recovery_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  conditions TEXT NOT NULL,
  actions TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_jobs (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  result TEXT,
  FOREIGN KEY (policy_id) REFERENCES recovery_policies(id)
);

CREATE INDEX IF NOT EXISTS idx_recovery_jobs_status ON recovery_jobs(status);
CREATE INDEX IF NOT EXISTS idx_recovery_jobs_policy ON recovery_jobs(policy_id);