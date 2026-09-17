-- Migration 147: add project_id to release_deployment_intents.
--
-- Phase 104 recovery executor needs project_id to reconstruct the canonical
-- CanonicalDeploymentRequest when resuming a durable intent after a crash.
-- Nullable for backward compatibility with Phase 103 intents that were
-- created before this column existed.
ALTER TABLE release_deployment_intents ADD COLUMN project_id TEXT;