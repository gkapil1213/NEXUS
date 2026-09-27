# Phase 207 - DAG and Dispatch Integration

## Scheduler tick composition

DistributedScheduler.tick() performs, in order:

1. Stale ADMITTED admission recovery (expireStaleAdmissionsAsync).
2. Retry promotion (promoteDueRetriesAsync): RETRY_SCHEDULED -> QUEUED.
3. Durable admission (admitNextJobAsync) up to global capacity.
4. Dispatch (dispatchTick -> dispatchAdmittedJobAsync).

Phase 207 does not modify this composition.

## What the kernel loop adds

Each interval, the kernel calls:

    scheduler.recoverStaleAttemptsTick(now)
    scheduler.tick(now)

Ordering rationale: stale-attempt recovery fences stale RUNNING attempts,
expires their leases, and requeues jobs whose retry policy allows another
attempt. Running before tick() makes freed capacity available to admission
in the same pass.

## DAG progression

DAG progression is not part of the scheduler tick. It lives in:

- src/core/execution-reconciler.ts - runStageGraphToCompletion call site.
- src/core/stage-dispatch-driver.ts - the DAG walker.
- src/core/stage-admission.ts, stage-eligibility.ts - dependency gating.

Phase 207 does not wire these directly. They are reached through
ExecutionEngine.recoverStaleJobs() finalization, which the kernel's
executionReconcileTimer invokes, using listExecutionsNeedingReconciliation
and finalizeExecution.

## Concurrency invariants preserved

- One queued job cannot be admitted twice: admitNextJobAsync uses
  pg_advisory_xact_lock.
- One admitted job cannot produce duplicate active attempts:
  dispatchAdmittedJobAsync CAS on status='ADMITTED'.
- Worker capacity: dispatchAdmittedJobAsync checks durable limit.
- Only the current lease owner can progress an attempt: recoverJobAtomic.
- Old workers cannot progress after takeover: Phase 206 fencing.
- A stage cannot execute before dependencies satisfy eligibility.
- Terminal executions cannot be resurrected: recoverStaleJobs skips them.
