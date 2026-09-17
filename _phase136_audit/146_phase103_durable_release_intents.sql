-- Migration 146: durable production release deployment intents
CREATE TABLE IF NOT EXISTS release_deployment_intents (
  intent_key TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  environment TEXT NOT NULL,
  image_repository TEXT NOT NULL,
  image_tag TEXT NOT NULL,
  image_id TEXT,
  image_digest TEXT NOT NULL,
  container_name TEXT NOT NULL,
  container_port INTEGER NOT NULL,
  status TEXT NOT NULL,
  deployment_id TEXT,
  failure_reason TEXT,
  recovery_reason TEXT,
  leased_by TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_intents_status
ON release_deployment_intents(status);

CREATE INDEX IF NOT EXISTS idx_release_intents_release_environment
ON release_deployment_intents(release_id, environment);
