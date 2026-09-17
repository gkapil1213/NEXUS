-- Migration 153: Phase 138 — durable production execution authorizations.
--
-- Replaces the process-local Map in ProductionReleaseEnforcementService with a
-- durable record. The Map is retained for one commit as a dual-write cache;
-- reads prefer the durable row when present.
--
-- Design notes:
--   * consumed_at / revoked_at are nullable timestamps, not booleans. The
--     timestamp is what Phase 138 15 audit events need, and it makes
--     "was this consumed by *this* attempt?" answerable without a second read.
--   * consumed_by_attempt_id binds consumption to a specific attempt. Phase 138
--     3: a crash between authorizeExecution returning AUTHORIZED and the
--     provider being invoked must not burn the authorization for a same-attempt
--     retry, but must block a different attempt from reusing it.
--   * No DB CHECK constraint on status values. State validity is enforced by
--     the TypeScript enum, consistent with release_deployment_intents.

CREATE TABLE IF NOT EXISTS production_execution_authorizations (
  authorization_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  environment TEXT NOT NULL,
  security_decision_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  execution_id TEXT,
  project_id TEXT,
  image_repository TEXT,
  image_tag TEXT,
  image_id TEXT,
  container_name TEXT,
  container_port INTEGER,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_attempt_id TEXT,
  revoked_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prod_auth_release_env
  ON production_execution_authorizations(release_id, environment);

CREATE INDEX IF NOT EXISTS idx_prod_auth_consumed_by
  ON production_execution_authorizations(consumed_by_attempt_id);

CREATE INDEX IF NOT EXISTS idx_prod_auth_expires
  ON production_execution_authorizations(expires_at);