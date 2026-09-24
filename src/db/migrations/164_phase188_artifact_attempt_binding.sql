-- Phase 188: attempt-bound artifact publication.
-- Adds attempt_id so an artifact is attributed to the exact execution attempt
-- that produced it. Prevents a stale worker from publishing an artifact that
-- becomes visible as the result of a newer attempt.

ALTER TABLE execution_artifacts ADD COLUMN attempt_id TEXT;
CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON execution_artifacts (attempt_id);
