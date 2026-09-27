# Phase 207 — Architecture Gap

Status: closed.

## What was missing

`src/core/distributed-scheduler.ts` is production-grade PostgreSQL-backed
scheduling code. Before Phase 207 it had zero constructors and zero imports
anywhere in `src/`. `DistributedScheduler.tick()` and
`DistributedScheduler.recoverStaleAttemptsTick()` had no callers.

## What Phase 207 added

1. `NexusKernel.startDistributedScheduler()` / `stopDistributedScheduler()`
   following the opt-in `startGateway()` / `startRecoverySupervisor()`
   convention. `boot()` never starts it.
2. `NexusKernel.getDistributedSchedulerStatus()` for observability.
3. `NEXUS_SCHEDULER_INTERVAL_MS` (default 5000, non-positive disables).
4. A synchronous `executionReconcileTimer` calling `recoverStaleJobs()`
   in both modes, gated by `NEXUS_EXEC_RECONCILE_MS` (default 30000).
5. Two `NexusEventType` entries: `execution.reconcile.tick_error` and
   `scheduler.tick_error`.
6. A dynamic-import/static-import mismatch in `kernel.ts:304` was fixed
   so `getPgClient()` sees the singleton set by `setPgClient()` at boot.

## Unchanged

`ReleaseRecoverySupervisor`, `CicdReconciliationScheduler`,
`ExecutionEngine.recoverStaleJobs()`, and `ExecutionStore` keep their
current responsibilities. Phase 206 lease/fencing semantics are unchanged.
