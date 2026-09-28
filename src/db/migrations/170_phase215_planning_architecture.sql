-- Migration 170: Phase 215 - engineering requests, plans, architecture specs.

CREATE TABLE IF NOT EXISTS engineering_requests (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  request_text TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_by   TEXT,
  metadata     TEXT,
  created_at   BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_engineering_requests_hash
  ON engineering_requests(run_id, request_hash);
CREATE INDEX IF NOT EXISTS idx_engineering_requests_run
  ON engineering_requests(run_id, created_at);

CREATE TABLE IF NOT EXISTS engineering_plans (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  version             INTEGER NOT NULL,
  objective           TEXT NOT NULL,
  scope               TEXT,
  requirements_json   TEXT NOT NULL,
  constraints_json    TEXT NOT NULL,
  assumptions_json    TEXT NOT NULL,
  acceptance_json     TEXT NOT NULL,
  planned_stages_json TEXT NOT NULL,
  dependencies_json   TEXT NOT NULL,
  risks_json          TEXT NOT NULL,
  verification_json   TEXT NOT NULL,
  status              TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  created_by          TEXT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  UNIQUE (run_id, version)
);
CREATE INDEX IF NOT EXISTS idx_engineering_plans_run
  ON engineering_plans(run_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_engineering_plans_status
  ON engineering_plans(run_id, status);

CREATE TABLE IF NOT EXISTS architecture_specifications (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  plan_id             TEXT NOT NULL,
  version             INTEGER NOT NULL,
  system_overview     TEXT NOT NULL,
  components_json     TEXT NOT NULL,
  interfaces_json     TEXT NOT NULL,
  data_model_json     TEXT NOT NULL,
  runtime_model_json  TEXT NOT NULL,
  security_model_json TEXT NOT NULL,
  deployment_json     TEXT NOT NULL,
  observability_json  TEXT NOT NULL,
  failure_handling    TEXT,
  technology_json     TEXT NOT NULL,
  constraints_json    TEXT NOT NULL,
  verification_json   TEXT NOT NULL,
  status              TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  created_by          TEXT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  UNIQUE (run_id, version)
);
CREATE INDEX IF NOT EXISTS idx_architecture_specs_run
  ON architecture_specifications(run_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_architecture_specs_plan
  ON architecture_specifications(plan_id);
