-- Phase 292: envelope persistence + outbox + reconciliation audit + monotonic fencing.
-- Monotonic fencing_token provides stale-owner protection beyond lease expiry
-- (per Phase 292 design decision 4). Every CAS write on worker_message_ids
-- MUST include fencing_token = current to reject stale-owner updates.

CREATE TABLE IF NOT EXISTS worker_message_envelopes (
  message_id TEXT PRIMARY KEY,
  message_type TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  envelope_version INTEGER NOT NULL DEFAULT 1,
  accepted_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES worker_message_ids(message_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_envelopes_type ON worker_message_envelopes (message_type);
CREATE INDEX IF NOT EXISTS idx_worker_envelopes_accepted_at ON worker_message_envelopes (accepted_at);

CREATE TABLE IF NOT EXISTS worker_external_side_effects (
  idempotency_key TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_ATTEMPT',
  attempted_at INTEGER NOT NULL,
  completed_at INTEGER,
  outcome TEXT,
  reason TEXT,
  evidence_json TEXT,
  FOREIGN KEY (message_id) REFERENCES worker_message_ids(message_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_outbox_status ON worker_external_side_effects (status, attempted_at);
CREATE INDEX IF NOT EXISTS idx_worker_outbox_message ON worker_external_side_effects (message_id);

CREATE TABLE IF NOT EXISTS worker_message_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  action TEXT NOT NULL,
  prior_status TEXT,
  new_status TEXT,
  reason TEXT NOT NULL,
  evidence_refs TEXT,
  reconciled_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES worker_message_ids(message_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_reconciliation_message
  ON worker_message_reconciliations (message_id, reconciled_at DESC);

-- Phase 292: monotonic fencing token + retry tracking + quarantine reason.
ALTER TABLE worker_message_ids ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worker_message_ids ADD COLUMN next_retry_at INTEGER;
ALTER TABLE worker_message_ids ADD COLUMN quarantine_reason TEXT;
ALTER TABLE worker_message_ids ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_worker_message_ids_retry_due
  ON worker_message_ids (next_retry_at)
  WHERE handler_status = 'RETRY_PENDING';