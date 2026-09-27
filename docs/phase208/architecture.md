# Phase 208 - Architecture

Phase 208 strengthens the contract between a claimed job and its durable terminal outcome.
It does not introduce a new scheduler, lease manager, DAG engine, or result table. Every
capability it verifies already exists in Phase 201-207 infrastructure.

## Components reused (unmodified unless noted)

- ExecutionStore.admitNextJobAsync / dispatchAdmittedJobAsync
- ExecutionStore.completeAttemptAndTransitionJobAsync
- ExecutionStore.recordAttemptHeartbeatAsOwnerAsync
- ExecutionStore.recordAttemptProgressAsOwnerAsync
- ExecutionStore.getAttemptResultAsync / getExecutionResultAsync
- ExecutionStore.listAttemptArtifactsAsync
- ExecutionStore.fenceStaleAttemptAsync / listStaleAttemptsAsync
- DistributedScheduler.tick / recoverStaleAttemptsTick
- ExecutionEngine.recoverStaleJobs
- LeaseManager

## The only production change in Phase 208

pg-bootstrap.ts now adds:

    ALTER TABLE execution_attempts ADD COLUMN IF NOT EXISTS last_progress_at BIGINT;
    CREATE INDEX idx_attempts_progress_running ON execution_attempts (status, last_progress_at) WHERE status = 'RUNNING';

Reason: recordAttemptProgressAsOwnerAsync writes last_progress_at. Migration 165 adds
that column for SQLite only. Without the Postgres mirror, Phase 197's progress-stale
supervision classifier could not observe Postgres executions. This was a real
production gap exposed by Phase 208's honest test runs.
