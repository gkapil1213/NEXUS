# Phase 207 - Recovery Integration

## Two independent recovery domains

### Release / deployment intents

- ReleaseRecoverySupervisor -> ReleaseRecoveryExecutor.runOnce().
- Scans ReleaseDeploymentIntent rows.
- Performs rollback, verify, and post-run reconcile of deployments.
- Never touches ExecutionJob, ExecutionAttempt, or execution leases.

### Execution jobs / attempts / leases

Two cooperating paths, one per persistence mode:

- Shared (PostgreSQL):
  DistributedScheduler.recoverStaleAttemptsTick(now) finds stale RUNNING
  attempts, fences, expires leases, transitions jobs through ORPHANED,
  applies retry policy, and requeues when eligible.
- Both modes:
  ExecutionEngine.recoverStaleJobs(now) runs Phase 196 supervision,
  Phase 197 stall fence, Phase 194 lease expiry, retry promotion (sync),
  and Phase 207 execution finalization.

The two execution paths are not redundant. The scheduler tick covers
ExecutionStore async primitives that do not exist in the sync path; the
engine tick covers phases 194/196/197/204/207 that are not in the scheduler
tick. All mutating operations are CAS-gated by recoverJobAtomic or
fenceStaleAttemptAsync.

## ReleaseRecoverySupervisor is not modified

Release recovery remains in ReleaseRecoveryExecutor.runOnce(). Execution
recovery remains in the two paths above.

## Restart safety

Both loops are restart-safe:

- Scheduler tick is idempotent across processes via PostgreSQL advisory
  locks and status CAS.
- Engine tick is idempotent across processes via recoverJobAtomic CAS.
- Reconciliation timer is unref'd and cleared before pool close in both
  shutdown() and cleanupOnFailedBoot().

## Known limitation

finalizeExecution in the engine path targets the synchronous store
(this.db). Shared-mode execution-graph finalization is not implemented by
this phase and is guarded with if (!this.store.hasAsyncBackend()).
