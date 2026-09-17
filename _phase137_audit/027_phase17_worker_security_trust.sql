-- Phase 17.6: Worker Security, Isolation & Trust Hardening
CREATE TABLE IF NOT EXISTS worker_trust (
  worker_id TEXT PRIMARY KEY,
  trust_state TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'LOW',
  reason TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS worker_security_events (
  event_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  session_id TEXT,
  job_id TEXT,
  attempt_id TEXT,
  dispatch_id TEXT,
  lease_id TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE TABLE IF NOT EXISTS worker_credentials (
  credential_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES remote_workers(worker_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_trust_state ON worker_trust(trust_state);
CREATE INDEX IF NOT EXISTS idx_worker_security_events_worker ON worker_security_events(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_credentials_worker ON worker_credentials(worker_id);
