# Phase 208 - Execution Lifecycle

## Canonical path (shared PostgreSQL mode)

    QUEUED
      |  admitNextJobAsync (advisory lock)
      v
    ADMITTED
      |  dispatchAdmittedJobAsync (row FOR UPDATE)
      v
    CLAIMED  +  attempt=RUNNING  +  lease=ACTIVE
      |  recordAttemptHeartbeatAsOwnerAsync
      |  recordAttemptProgressAsOwnerAsync
      |  worker executes
      v
    completeAttemptAndTransitionJobAsync (single transaction)
      |
      +-- attempt=SUCCEEDED/FAILED/CANCELLED
      +-- job=SUCCEEDED/FAILED/CANCELLED/RETRY_SCHEDULED
      +-- lease released
      +-- artifacts inserted
      +-- execution_outcome_provenance row (immutable)
      +-- execution_events row (execution.transition.<status>)

## Result contract

getAttemptResultAsync(attemptId) returns:
  { attempt, job, provenance, artifacts }

getExecutionResultAsync(jobId) returns:
  { job, attempt, provenance, artifacts, events }

Both read from the async backend when in shared mode. provenance is immutable
by construction (no UPDATE / DELETE path). outcome is one of SUCCEEDED / FAILED /
CANCELLED (and the retry variant RETRY_SCHEDULED when applicable).

## Ownership fencing

Every mutating method on ExecutionStore that touches an attempt requires the
quadruple (attempt_id, job_id, lease_id, worker_id). A stale worker whose lease
has been expired or replaced receives WORKER_OWNERSHIP_LOST or ATTEMPT_STATE_MISMATCH.

## Retry

FAILED -> RETRY_SCHEDULED -> QUEUED -> ADMITTED -> CLAIMED -> attempt#2 (new attempt_number).
The completion API accepts a patch.nextAttemptAt; promoteDueRetriesAsync promotes
when next_attempt_at <= now. Old attempts are never reused.
