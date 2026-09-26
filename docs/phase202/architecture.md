# Phase 202 Architecture

## Baseline

Phase 201 established canonical dependency edges (`execution_stage_dependencies`)
and orchestrator-level gating on top of the existing `execution_jobs` stage
projection (`stage-execution-store-adapter.ts`). Phase 202 adds the durable
runtime admission layer that gates stage execution based on those edges.

## Layers

    executor (existing)
       ?
    CI/CD orchestrator (worker-autonomous-cicd-orchestrator.ts)
       ? dependency gate (202b, 202d)
    evaluateStageAdmission / evaluateStageAdmissionAsync
       ?
    isStageEligible (pure)
       ?
    StageExecutionStoreAdapter
       ?
    ExecutionStore (sync + async siblings)
       ?
    execution_jobs (job_type='pipeline.stage')
    execution_stage_dependencies (canonical edges)
    execution_leases (existing atomic claim)

## Key invariants

1. A stage is admitted only when every declared dependency is SUCCEEDED.
2. Terminal dependency failure (FAILED/DEAD_LETTER/CANCELLED/SKIPPED)
   blocks downstream admission with `DEPENDENCY_TERMINAL_FAILURE`.
3. In-flight dependency (`RUNNING/CLAIMED/VERIFYING/ADMITTED`) blocks with
   `DEPENDENCY_IN_FLIGHT`.
4. Retry-pending dependency (job status `RETRY_SCHEDULED`) blocks with
   `DEPENDENCY_RETRY_PENDING` — this is *not* a terminal failure.
5. Cancelled execution blocks every stage with `EXECUTION_CANCELLED`.
6. Admission is deterministic for a given durable state.
7. No new dependency model was introduced. No new claim mechanism.
8. `atomicClaimJob` / `LeaseManager.acquireLease` remain the authoritative
   single-owner primitive.

## Backend parity

- SQLite: `listStageJobsForExecution` uses `json_extract(payload, '$.executionId')`.
- PostgreSQL: `listStageJobsForExecutionAsync` uses `payload::jsonb ->> 'executionId'`.
- The orchestrator dispatches on `store.hasAsyncBackend()` and calls the
  async variant when shared.