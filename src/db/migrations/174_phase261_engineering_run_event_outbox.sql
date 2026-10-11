-- Migration 174: Phase 261 - transactional outbox for engineering_run_events.
-- Records delivery intent atomically with the job transition that produced
-- it. Delivered asynchronously by a drain worker with bounded retries.
-- Destination writes are idempotent on event_id.

CREATE TABLE IF NOT EXISTS engineering_run_event_outbox (
  outbox_id        TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  job_id           TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  stage_id         TEXT,
  event_type       TEXT NOT NULL,
  payload          TEXT,
  created_at       INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  claimed_at       INTEGER,
  claimed_by       TEXT,
  claim_expires_at INTEGER,
  delivered_at     INTEGER,
  last_error       TEXT,
  permanently_failed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency_key
  ON engineering_run_event_outbox(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON engineering_run_event_outbox(next_attempt_at)
  WHERE delivered_at IS NULL AND permanently_failed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_expired_claims
  ON engineering_run_event_outbox(claim_expires_at)
  WHERE delivered_at IS NULL AND claimed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_failed
  ON engineering_run_event_outbox(permanently_failed_at)
  WHERE permanently_failed_at IS NOT NULL;