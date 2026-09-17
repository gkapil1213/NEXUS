-- Phase 17.7: Worker Credential Rotation, Revocation & Zero-Trust Re-enrollment
CREATE TABLE IF NOT EXISTS worker_credential_lifecycle (
  credential_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL,
  credential_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  previous_credential_id TEXT,
  replacement_credential_id TEXT,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  rotated_at INTEGER,
  revoked_at INTEGER,
  revocation_reason TEXT,
  last_used_at INTEGER,
  metadata TEXT,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_credential_version ON worker_credential_lifecycle(worker_id, credential_version);
CREATE INDEX IF NOT EXISTS idx_worker_credential_worker ON worker_credential_lifecycle(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_credential_status ON worker_credential_lifecycle(status);
