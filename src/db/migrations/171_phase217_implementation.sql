-- Migration 171: Phase 217 - engineering implementation specification.
--
-- Persists an AI-proposed ImplementationSpec bound to a run, workspace,
-- plan, and architecture. Content hash is the canonical serialization hash
-- computed by implementation-contracts.ts. Status follows the same lifecycle
-- vocabulary used by engineering_plans (PROPOSED/VALIDATED/INVALID/APPLIED/
-- FAILED/BLOCKED).

CREATE TABLE IF NOT EXISTS implementation_specifications (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  plan_id           TEXT NOT NULL,
  architecture_id   TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  model             TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  operations_json   TEXT NOT NULL,
  status            TEXT NOT NULL,
  created_by        TEXT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_impl_specs_run
  ON implementation_specifications(run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_impl_specs_plan
  ON implementation_specifications(plan_id);

CREATE INDEX IF NOT EXISTS idx_impl_specs_hash
  ON implementation_specifications(run_id, request_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_impl_specs_run_hash
  ON implementation_specifications(run_id, request_hash);