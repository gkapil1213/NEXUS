# Phase 205 Execution Reconciliation

## Gap closed

Prior to Phase 205 there was no per-execution reconciliation entry point.
Recovery primitives existed at the attempt level
(`recoverStalledAttemptsTick`) and job-sweep level (`recoverStaleJobs`),
but nothing composed them with the Phase 203 driver and Phase 204
finalizer for a single execution. Additionally, Phase 204's
`computeExecutionOutcome` treated any FAILED-status stage as terminal
failure, which incorrectly finalized a parent whose stage was in
RETRY_SCHEDULED (StageStatus collapses RETRY_SCHEDULED to FAILED).

## New module

`src/core/execution-reconciler.ts`

### `reconcileExecution(input): Promise<ReconcileResult>`

Composition, in order:
1. Read parent. If terminal ? NOOP_TERMINAL.
2. Fence stale attempts scoped to this execution's stage IDs
   (via `store.listStaleAttempts` filtered by stage ids + `fenceStaleAttempt`).
3. Record retry-pending stages (read-only).
4. Invoke `runStageGraphToCompletion` to advance any dispatchable work.
5. Delegate to `finalizeExecution` (Phase 204) for the parent transition.

Returns: `{ executionId, action, preStatus, postStatus, staleFencedAttempts,
retryPendingStages, dispatched, failed, blocked, finalized, reason }`.

Actions: `NOOP_TERMINAL | NOOP_RUNNING | FENCED | ADVANCED | FENCED_AND_ADVANCED`.

### `listExecutionsNeedingReconciliation(store): string[]`

Returns IDs of parent `pipeline` jobs currently in `RUNNING` or
`CANCELLATION_REQUESTED`. Callers then invoke `reconcileExecution` for each.

## Finalizer retry-awareness (Phase 205 patch to Phase 204)

`computeExecutionOutcome` now checks `derivedJobStatus === "RETRY_SCHEDULED"`
before terminal-failure checks:

    retry-pending stages      ? parent RUNNING (STAGES_RETRY_PENDING:N)
    then any terminal failure ? parent FAILED
    then all SUCCEEDED        ? parent SUCCEEDED

This prevents premature failure finalization while a retry is pending.

## Reused primitives (no new persistence)

- `store.listStaleAttempts` + `store.fenceStaleAttempt` — Phase 197
- `runStageGraphToCompletion` — Phase 203a
- `finalizeExecution` + `computeExecutionOutcome` — Phase 204
- `store.getJob`, `StageExecutionStoreAdapter.listForExecutionSync` — existing

No new schema. No new state machine. No new event system.