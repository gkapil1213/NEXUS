-- Migration 152: Phase 138 — durable deployment execution authority.
--
-- Additive columns on release_deployment_intents covering the fields Phase 138
-- §1 requires that are not already present. No new tables: the intent table is
-- the durable deployment record.
--
-- The TypeScript ReleaseIntentStatus enum is extended in lockstep with this
-- migration to include CANCELLED and UNKNOWN. No DB CHECK constraint exists,
-- so the enum is the authoritative state guard.

ALTER TABLE release_deployment_intents ADD COLUMN attempt_id TEXT;
ALTER TABLE release_deployment_intents ADD COLUMN provider TEXT;
ALTER TABLE release_deployment_intents ADD COLUMN provider_status TEXT;
ALTER TABLE release_deployment_intents ADD COLUMN provider_deployment_id TEXT;
ALTER TABLE release_deployment_intents ADD COLUMN started_at INTEGER;
ALTER TABLE release_deployment_intents ADD COLUMN completed_at INTEGER;
ALTER TABLE release_deployment_intents ADD COLUMN timeout_at INTEGER;
ALTER TABLE release_deployment_intents ADD COLUMN cancel_requested_at INTEGER;
ALTER TABLE release_deployment_intents ADD COLUMN cancel_acknowledged_at INTEGER;
ALTER TABLE release_deployment_intents ADD COLUMN verification_state TEXT;
ALTER TABLE release_deployment_intents ADD COLUMN reconciled_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_release_intents_provider_deployment
  ON release_deployment_intents(provider_deployment_id);

CREATE INDEX IF NOT EXISTS idx_release_intents_reconcile
  ON release_deployment_intents(status, reconciled_at);