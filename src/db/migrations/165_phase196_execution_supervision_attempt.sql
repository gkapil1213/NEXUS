-- Migration 165: Phase 196 - per-attempt heartbeat and progress.
--
-- Phase 187 added heartbeat_at BIGINT to Postgres execution_attempts via
-- pg-bootstrap.ts but never mirrored it to SQLite. The TS model field
-- ExecutionAttempt.heartbeatAt has therefore been dead on SQLite since.
-- This migration closes that gap and adds last_progress_at for the
-- supervision classifier.

ALTER TABLE execution_attempts ADD COLUMN heartbeat_at BIGINT;
ALTER TABLE execution_attempts ADD COLUMN last_progress_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_attempts_heartbeat_running
  ON execution_attempts (status, heartbeat_at) WHERE status = 'RUNNING';

CREATE INDEX IF NOT EXISTS idx_attempts_progress_running
  ON execution_attempts (status, last_progress_at) WHERE status = 'RUNNING';
