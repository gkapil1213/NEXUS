# Phase 202 Recovery Interaction

## Relationship to Phase 199/200

Phase 199/200 provide durable recovery operations for execution jobs. Phase
202 admission is compatible with that mechanism but does not replace it.

- If a stage's underlying job enters `RETRY_SCHEDULED`, admission treats the
  dependency as retry-pending (transient). Downstream stages remain blocked
  until the retry succeeds.
- If a stage's underlying job reaches `DEAD_LETTER`, admission treats the
  dependency as terminal failure. Downstream stages remain blocked with
  `DEPENDENCY_TERMINAL_FAILURE` — this matches the canonical NEXUS failure
  semantics where a dead-lettered job does not silently requeue.
- Recovery reclaim (Phase 200's `recoverStalledAttemptsTick`) modifies the
  job status; the next admission tick sees the updated durable state via
  `evaluateStageAdmissionAsync`.

## Restart durability

- Admission reads all state from durable storage: the execution job row
  (for `cancellation_requested`), the stage job rows (`job_type='pipeline.stage'`),
  and the dependency edges. No in-memory caches.
- Tested in `scripts/test-phase202-durable-admission.ts` S11 (SQLite) and
  `scripts/test-phase202c-concurrency.ts` S9 (SQLite).

## Cancellation

- `cancellation_requested=1` on the parent execution job is checked first.
  Every stage returns `EXECUTION_CANCELLED` regardless of its own state.
  This propagates a cancel at the top of the DAG without any additional
  mechanism.