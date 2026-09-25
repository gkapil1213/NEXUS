# NEXUS Phase 197 — Discovery

## Baseline

    HEAD:  ef08e6490ba040493aa79cb5d510df8ba0f956b1
    tag:   nexus-phase196-complete
    branch: master == origin/master

## Existing capabilities (reuse, do not rebuild)

### Phase 196 deliverables (in place)
- Migrations 165/166: `execution_attempts.heartbeat_at`, `.last_progress_at`;
  `execution_jobs.supervision_state`, `.failure_class`, `.supervision_updated_at`
- `ExecutionEngine.recordHeartbeat`, `.recordProgress` (fenced writes)
- `ExecutionEngine.classifySupervision` — HEALTHY / HEARTBEAT_TIMEOUT /
  PROGRESS_TIMEOUT / NOT_RUNNING / NO_ATTEMPT
- `ExecutionEngine.runSupervisionPass` — writes SUSPECTED_STALL + emits
  `execution.supervision.stall_detected`
- `ExecutionStore.listStaleAttempts` (sync), `.getAttemptProgress`,
  `.setJobSupervision`
- `CONFIG.recovery.{heartbeatTimeoutMs, progressTimeoutMs, staleAttemptMs}`

### Pre-existing (Phases 126–195)
- `ExecutionStateMachine` — RUNNING → ORPHANED → QUEUED; FAILED → RETRY_SCHEDULED / DEAD_LETTER
- `ExecutionEngine.applyTransition` — single entry for every durable job transition
- `ExecutionStore.acquireLease` — atomic expired-lease takeover (Phase 194)
- `execution_leases` with partial unique index `(job_id) WHERE status='ACTIVE'`
- `execution_recovery_operations` (migration 154) — durable idempotency per
  `(job_id, lease_id, operation_type)` via `recoveryOperationIdempotencyKey`
- `execution_ownership_obligations` (migration 149)
- `ExecutionStore.recoverJobAtomic` (sync, L566) and `.recoverJobAtomicAsync` (async, L846)
- `ExecutionStore.fenceStaleAttemptAsync` (async, L4785) — sets attempt FAILED,
  expires lease, transitions job to ORPHANED. CAS on
  `status='RUNNING' AND heartbeat_at < cutoff`
- `DistributedScheduler.recoverStaleAttemptsTick` — the async driver
- `RetryEngine` — attempt counting, backoff, dead-letter
- `execution_events` append-only log
- `AuditService`

## Exact production gap

Two concrete gaps. Both are real; neither is a fixture issue.

### Gap A — sync (SQLite) has no stall-recovery driver

The async path (`DistributedScheduler.recoverStaleAttemptsTick`) does the
whole loop for Postgres:

  listStaleAttemptsAsync
    -> fenceStaleAttemptAsync (attempt FAILED, lease EXPIRED, job ORPHANED)
    -> if job.retryPolicy && attempts.length < maxAttempts -> recoverJobAtomicAsync
         expectedStatus: ORPHANED, newStatus: QUEUED

The SQLite side has listStaleAttempts (added Phase 196) and
recoverJobAtomic (pre-existing), but:

- No sync `fenceStaleAttempt` primitive exists.
- `ExecutionEngine.recoverStaleJobs` (sync) iterates **expired leases**,
  not stale attempts. A stale heartbeat with an ACTIVE lease never
  enters the loop, so it never reaches the ORPHAN_RECOVERY /
  TIMEOUT / CANCELLATION branches.
- `runSupervisionPass` writes SUSPECTED_STALL and stops. It never calls
  fenceStaleAttempt, never creates a recovery operation, never touches
  ExecutionJobStatus.

Net result: in SQLite mode (the default in every test suite), a stalled
attempt is flagged and then abandoned.

### Gap B — progress-only stalls are invisible to both engines

`listStaleAttempts` and `listStaleAttemptsAsync` query:

    WHERE status = 'RUNNING' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?

An attempt with a fresh heartbeat but stale `last_progress_at` — exactly
the case `classifySupervision` returns as PROGRESS_TIMEOUT — is never
returned by either query. So even the async recovery driver cannot
recover a progress-only stall today.

Phase 196 gave us `last_progress_at` and the classifier branch, but
nothing scans for it.

## Why this cannot already be solved by existing infrastructure

- `runSupervisionPass` explicitly comments "does not touch
  ExecutionJobStatus". It is a signal emitter by design.
- `fenceStaleAttemptAsync` is Postgres-only (`requireAsyncDb()`).
- No sync mirror of `fenceStaleAttemptAsync` exists in
  `execution-store.ts`.
- `distributed-scheduler.ts` itself throws when
  `!store.hasAsyncBackend()` — it is not reachable in SQLite mode.
- The progress dimension has never been scanned by any recovery path.

## Exact files and functions involved

  src/core/execution-engine.ts
    runSupervisionPass     L848 — signal only, needs to drive recovery OR
                                   be split into signal + driver
    recoverStaleJobs       L1491 — iterates expired leases, not attempts

  src/core/execution-store.ts
    listStaleAttempts               (Phase 196, sync)
    recoverJobAtomic        L566    (pre-existing, sync)
    fenceStaleAttemptAsync  L4785   (async; sync twin missing)

  src/core/distributed-scheduler.ts
    recoverStaleAttemptsTick  L181  (async driver — the template)

  src/core/execution-recovery-operation-store.ts
    ExecutionRecoveryOperationType  L17
    recoveryOperationIdempotencyKey L82

  src/core/retry-engine.ts
    attempt count, backoff, dead-letter

## Is a schema change required?

No. The durable state needed already exists:

- `execution_jobs.supervision_state` / `failure_class` — Phase 196
- `execution_attempts.heartbeat_at` / `last_progress_at` — Phase 196
- `execution_leases` — Phase 020, partial index Phase 142
- `execution_recovery_operations` — Phase 154
- `execution_ownership_obligations` — Phase 149
- `execution_events` — Phase 020

Phase 197 requires no migration. It uses migration 165's index
`idx_attempts_progress_running` for the new progress-stale scan.

## Smallest correct fix

Three additions, all in existing files. No new state machine. No new
recovery system. No duplicate supervisor loop.

1. **`ExecutionStore.fenceStaleAttempt(input)` — sync twin of the async
   primitive.** Same SQL. Same CAS on `status='RUNNING'` and stale
   cutoff. Returns `{ fenced, alreadyFenced?, reason? }`. Does not need
   `BEGIN IMMEDIATE` — the CAS in the UPDATE is the fence.

2. **`ExecutionStore.listProgressStaleAttempts(now, maxAgeMs,
   heartbeatFreshMs)` — new scan.** Returns attempts where
   `status='RUNNING' AND last_progress_at IS NOT NULL AND
   last_progress_at < cutoff AND heartbeat_at > (now - heartbeatFreshMs)`.
   Uses `idx_attempts_progress_running` (migration 165).

3. **`ExecutionEngine.recoverStalledAttemptsTick(now)` — sync driver.**
   Mirrors `DistributedScheduler.recoverStaleAttemptsTick` in SQLite mode.
   For each attempt returned by `listStaleAttempts` OR
   `listProgressStaleAttempts`:
     - `fenceStaleAttempt({reason: HEARTBEAT_TIMEOUT | PROGRESS_TIMEOUT})`
     - if the job is now ORPHANED and `retryPolicy && attempts < maxAttempts`:
       `recoverJobAtomic({ORPHANED -> QUEUED, patch: {nextAttemptAt: now},
       event: execution.recovery.stale_attempt_requeued})`
     - if retry not allowed: leave ORPHANED with failure_class set; emit
       `execution.recovery.blocked`
   Called from `runSupervisionPass` after the classification loop, or
   directly from `recoverStaleJobs` after the supervision pass. Same
   `try { ... } catch {}` isolation.

Nothing in the async path changes. `distributed-scheduler.ts` continues
to be the Postgres recovery driver. Phase 197 gives SQLite parity plus
progress-timeout coverage in both engines.

## Operator-visible outcome

For any stalled attempt, the durable record answers:

  What was the stall?        supervision_state / failure_class on job
  Which attempt?             execution_attempts row (now FAILED)
  Which worker?              worker_id on attempt
  Which lease?               lease_id on attempt
  When?                      heartbeat_at / last_progress_at / supervision_updated_at
  What recovery?             execution_events entries
                             (stale_attempt_requeued, recovery.blocked)
  Recovered or blocked?      job.status (QUEUED vs ORPHANED) + failure_class
  Why blocked?               failure_class (RETRY_EXHAUSTED vs stall class)

No new operator surface is added. Existing events and columns carry all
of this.

## Preserved

- Phase 196 supervision pass, classification, and evidence
- Phase 194 atomic expired-lease takeover
- All published migrations (no change)
- `nexus-phase196-complete` tag untouched
- Async Postgres recovery path untouched
