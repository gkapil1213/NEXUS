-- Migration 160: Phase 175 - durable recovery retry state on release intents.
--
-- The release-recovery executor may encounter the same RECOVERY_REQUIRED
-- intent on every supervisor tick. Without durable retry bookkeeping this
-- becomes an unbounded recovery storm against an unavailable provider or
-- broken environment.
--
-- Three additive columns:
--   recovery_attempts   monotonically increasing count of recovery passes
--                       that terminated in RECOVERY_REQUIRED for this intent
--   next_retry_at       earliest timestamp at which the supervisor may
--                       re-attempt recovery. NULL means eligible immediately
--                       (fresh intent, or explicit operator reset).
--   last_failure_class  opaque classification string from the failure that
--                       caused the most recent RECOVERY_REQUIRED write
--                       (e.g. "PROVIDER_UNKNOWN", "DOCKER_BLOCKED").
--
-- Backward compatible: existing rows default to 0/NULL/NULL, which
-- preserves pre-Phase-175 behavior for every non-terminal intent.

ALTER TABLE release_deployment_intents ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE release_deployment_intents ADD COLUMN next_retry_at INTEGER;
ALTER TABLE release_deployment_intents ADD COLUMN last_failure_class TEXT;

CREATE INDEX IF NOT EXISTS idx_release_intents_next_retry
ON release_deployment_intents(next_retry_at);