-- Phase 179: HTTP-level idempotency for operator control requests.
-- Additive, restart-safe, backwards compatible. Request-level idempotency
-- for POST /api/recovery/* control actions. Distinct from job-level
-- idempotency (execution_jobs) and from execution_recovery_operations.
CREATE TABLE IF NOT EXISTS http_idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  principal_id    TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_http_idem_created
  ON http_idempotency_keys(created_at);