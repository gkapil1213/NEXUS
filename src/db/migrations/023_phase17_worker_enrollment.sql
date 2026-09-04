-- Phase 17.1: Production Worker Enrollment & Bootstrap
CREATE TABLE IF NOT EXISTS worker_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_enrollments_worker ON worker_enrollments(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_enrollments_status ON worker_enrollments(status);
