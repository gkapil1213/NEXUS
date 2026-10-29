-- Phase 289: durable replay protection for worker gateway messages.
-- Column names match WorkerTransportSecurity's inline CREATE TABLE.
-- Idempotent: no-op if the table was already created by the security class.
CREATE TABLE IF NOT EXISTS worker_message_ids (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_message_ids_session
  ON worker_message_ids (session_id);