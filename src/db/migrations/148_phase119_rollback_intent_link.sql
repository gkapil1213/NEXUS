-- Migration 148: Phase 119 rollback intent linkage.
ALTER TABLE release_deployment_intents ADD COLUMN intent_kind TEXT NOT NULL DEFAULT 'DEPLOY';
ALTER TABLE release_deployment_intents ADD COLUMN rollback_target_release_id TEXT;
ALTER TABLE release_deployment_intents ADD COLUMN rollback_job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_release_intents_kind ON release_deployment_intents(intent_kind);
CREATE INDEX IF NOT EXISTS idx_release_intents_rollback_target ON release_deployment_intents(rollback_target_release_id);
CREATE INDEX IF NOT EXISTS idx_release_intents_rollback_job ON release_deployment_intents(rollback_job_id);
