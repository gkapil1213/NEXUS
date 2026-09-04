-- Phase 12: Recovery orchestration attempts
CREATE TABLE IF NOT EXISTS recovery_attempts (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  action_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  verification_result INTEGER,
  evidence_json TEXT NOT NULL,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  idempotency_key TEXT UNIQUE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_attempts_incident ON recovery_attempts(incident_id);
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_idempotency ON recovery_attempts(idempotency_key);