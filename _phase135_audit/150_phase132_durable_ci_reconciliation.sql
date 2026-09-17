-- 150_phase132_durable_ci_reconciliation.sql
-- Phase 132: durable ledger for remote CI artifact reconciliation.
--
-- One row per (provider_id, external_run_id). Survives process restart so the
-- reconciler can resume artifact discovery without redispatching.
--
-- The authoritative CI run record itself lives in the NexusEngine generic
-- store (`ci_pipeline_runs`); this table is the Phase 132 reconciliation
-- companion that needs a real UNIQUE constraint to make repeated
-- reconciliation idempotent.

CREATE TABLE IF NOT EXISTS ci_artifact_reconciliations (
  reconciliation_id      TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL,           -- ci_pipeline_runs.id
  execution_id           TEXT NOT NULL,
  project_id             TEXT,
  provider_id            TEXT NOT NULL,
  external_run_id        TEXT NOT NULL,
  repository             TEXT NOT NULL,           -- "owner/repo"
  commit_sha             TEXT NOT NULL,
  workflow_file          TEXT,

  -- State machine:
  --   PENDING              -- created; CI status not yet SUCCEEDED
  --   ARTIFACT_DISCOVERING -- listing artifacts
  --   ARTIFACT_VALIDATING  -- downloading / parsing / validating
  --   REGISTERED           -- IMAGE_DIGEST durably registered
  --   BLOCKED              -- terminal, non-success, machine-readable reason
  state                  TEXT NOT NULL DEFAULT 'PENDING',
  blocked_reason         TEXT,

  github_artifact_id     TEXT,
  github_artifact_name   TEXT,
  github_artifact_size   INTEGER,
  github_artifact_url    TEXT,

  image_repository       TEXT,
  image_tag              TEXT,
  image_digest           TEXT,
  immutable_reference    TEXT,
  registered_artifact_id TEXT,

  attempts               INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  completed_at           INTEGER,

  UNIQUE (provider_id, external_run_id),
  UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS idx_cir_execution
  ON ci_artifact_reconciliations (execution_id);

CREATE INDEX IF NOT EXISTS idx_cir_open
  ON ci_artifact_reconciliations (state)
  WHERE state IN ('PENDING','ARTIFACT_DISCOVERING','ARTIFACT_VALIDATING');

-- Immutable binding ledger: one row per (execution, run, digest). Enforces the
-- "duplicate digest cannot overwrite authoritative evidence" rule.
CREATE TABLE IF NOT EXISTS ci_image_digest_bindings (
  binding_id            TEXT PRIMARY KEY,
  execution_id          TEXT NOT NULL,
  project_id            TEXT,
  run_id                TEXT NOT NULL,
  provider_id           TEXT NOT NULL,
  external_run_id       TEXT NOT NULL,
  repository            TEXT NOT NULL,
  commit_sha            TEXT NOT NULL,
  image_repository      TEXT NOT NULL,
  image_tag             TEXT NOT NULL,
  image_digest          TEXT NOT NULL,
  immutable_reference   TEXT NOT NULL,
  nexus_artifact_id     TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  UNIQUE (execution_id, run_id, image_digest)
);

CREATE INDEX IF NOT EXISTS idx_cidb_execution
  ON ci_image_digest_bindings (execution_id);