-- Migration 169: Phase 214 - engineering run orchestration.
--
-- Engineering runs are a thin metadata layer over the existing execution
-- infrastructure. engineering_runs.id IS the parent execution_jobs.id
-- (job_type='engineering.run'). engineering_run_stages.id IS the stage
-- execution_jobs.id (job_type='engineering.stage'). This reuses the Phase
-- 201-213 DAG/admission/dispatch/lease/fencing/recovery machinery unchanged.

CREATE TABLE IF NOT EXISTS engineering_runs (
  id                   TEXT PRIMARY KEY,
  idempotency_key      TEXT UNIQUE NOT NULL,
  objective            TEXT NOT NULL,
  normalized_objective TEXT NOT NULL,
  repository           TEXT NOT NULL,
  source_revision      TEXT,
  current_stage        TEXT,
  revision             INTEGER NOT NULL DEFAULT 1,
  correlation_id       TEXT NOT NULL,
  requested_by         TEXT,
  execution_context    TEXT,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_engineering_runs_created
  ON engineering_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_engineering_runs_current_stage
  ON engineering_runs(current_stage);

CREATE TABLE IF NOT EXISTS engineering_run_stages (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  stage_type        TEXT NOT NULL,
  ordinal           INTEGER NOT NULL,
  capability_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  capability_reason TEXT,
  blocked_at        BIGINT,
  started_at        BIGINT,
  completed_at      BIGINT,
  artifact_ref      TEXT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  UNIQUE (run_id, stage_type, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_engineering_run_stages_run
  ON engineering_run_stages(run_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_engineering_run_stages_capability
  ON engineering_run_stages(run_id, capability_status);

CREATE TABLE IF NOT EXISTS engineering_run_events (
  event_id   TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  stage_id   TEXT,
  event_type TEXT NOT NULL,
  payload    TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_engineering_run_events_run
  ON engineering_run_events(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_engineering_run_events_type
  ON engineering_run_events(event_type);
