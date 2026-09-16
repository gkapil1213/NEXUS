-- 151_phase134_reconciliation_worker_ownership.sql
-- Phase 134: singleton durable ownership of the CI reconciliation scheduler.
--
-- At most one row may be in state='ACTIVE' at any time. Enforced by a partial
-- unique index. Ownership expires via expires_at, so a crashed owner never
-- wedges the scheduler permanently.
--
-- This table is deliberately separate from execution_leases: execution leases
-- model job ownership, while this models which NEXUS instance currently owns
-- the CI reconciliation scheduler loop.

CREATE TABLE IF NOT EXISTS ci_reconciliation_worker_ownership (
  ownership_id      TEXT PRIMARY KEY,           -- singleton: 'ci-reconciliation-scheduler'
  worker_id         TEXT NOT NULL,
  lease_id          TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | RELEASED | EXPIRED
  acquired_at       INTEGER NOT NULL,
  renewed_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  released_at       INTEGER,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cirwo_singleton_active
  ON ci_reconciliation_worker_ownership (ownership_id)
  WHERE state = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_cirwo_state_expires
  ON ci_reconciliation_worker_ownership (state, expires_at);