# NEXUS Phase 196 — Execution Supervision Evidence

## 1. Scope

Phase 196 was scoped to production execution supervision: durable
heartbeat/progress tracking, stall detection, and recovery integration.
Implementation boundary determined by discovery (commit 39e96f8).

## 2. Baseline

    HEAD at start:  f9f2f91648750d2feed9335275a4fe29b0ef1c93
    tag:            nexus-phase195-complete
    branch:         master == origin/master

Phase 195 remains intact. No published migration was modified.

## 3. Repository discovery (commit 39e96f8)

Actual paths verified, not assumed:

    migration directory  src/db/migrations/ (151 files at start, 153 after Phase 196)
    migration runner     src/core/migration-runner.ts
    bootstrap            src/core/sqlite-engine.ts SQLiteEngine.open()
    async supervisor     src/core/distributed-scheduler.ts (Phase 187)

What already existed (reused, not rebuilt):

  - ExecutionStateMachine + applyTransition (single entry for every durable job transition)
  - ExecutionStore.acquireLease atomic expired-lease takeover (Phase 194)
  - execution_leases with partial unique index on (job_id) WHERE status='ACTIVE'
  - execution_recovery_operations + execution_ownership_obligations (durable idempotency)
  - distributed-scheduler.ts running listStaleAttemptsAsync / fenceStaleAttemptAsync
  - release-recovery-supervisor.ts (Phase 125)
  - execution_events append-only log, AuditService
  - src/api/recovery/routes.ts (intent-level operator control)

## 4. Root cause of the gap

Two distinct production defects were uncovered by discovery:

**A. heartbeat_at was Postgres-only.**
Phase 187 added `heartbeat_at BIGINT` to execution_attempts in Postgres
via pg-bootstrap.ts, and Phase 187 built the async supervisor primitives
(listStaleAttemptsAsync, fenceStaleAttemptAsync). But the SQLite
execution_attempts table never got the column, and no sync variants of
the supervisor primitives ever existed. The TS model field
`ExecutionAttempt.heartbeatAt` was dead on SQLite, and every code path
in execution-store.ts that referenced `heartbeat_at` would have thrown
`no such column` on SQLite. This is the actual reason Phase 136 was
reporting `FATAL: table execution_artifacts has no column named
attempt_id` / `no such table: execution_recovery_operations` in Phases
194 and 195 — the fixture was not the only problem.

**B. last_progress_at did not exist at all.**
There was no column, no model field, no store method, and no classifier
input for "meaningful progress". A worker whose dispatch was deadlocked
or whose external call was hung would keep renewing its lease
indefinitely — Phase 194's expired-lease recovery path could not see it.

## 5. Fix

Four commits after the discovery doc:

    3f8501b  feat(phase196): execution supervision schema
             migrations 165 + 166

    b18ce23  feat(phase196): execution supervision runtime
             - ExecutionAttempt.lastProgressAt
             - CONFIG.recovery.{heartbeatTimeoutMs, progressTimeoutMs, staleAttemptMs}
             - store: listStaleAttempts (sync), recordAttemptHeartbeatAsOwner,
               recordAttemptProgressAsOwner, getAttemptProgress
             - engine: recordHeartbeat, recordProgress, classifySupervision

    2a460fe  feat(phase196): supervisor tick — stall detection pass
             - store: setJobSupervision
             - engine: runSupervisionPass
             - call from recoverStaleJobs (does not touch ExecutionJobStatus)

    <pending> test(phase196): execution supervision verification
             scripts/test-phase196-execution-supervision.ts

Migration 165:
    ALTER TABLE execution_attempts ADD COLUMN heartbeat_at BIGINT;
    ALTER TABLE execution_attempts ADD COLUMN last_progress_at BIGINT;
    + partial indexes on (status, heartbeat_at) and (status, last_progress_at)
      WHERE status='RUNNING'

Migration 166:
    ALTER TABLE execution_jobs ADD COLUMN supervision_state TEXT;
    ALTER TABLE execution_jobs ADD COLUMN failure_class TEXT;
    ALTER TABLE execution_jobs ADD COLUMN supervision_updated_at BIGINT;
    + partial index on (supervision_state, supervision_updated_at)
      WHERE supervision_state IS NOT NULL

Existing rows get NULL. Phase 126–195 behavior is preserved.

## 6. Fresh database evidence

Migration chain (via SQLiteEngine.open()):

    Migration file count: 153
    §2 migration history populated  history=153 files=153
    §2 no migration missing from history
    §2 no checksum drift  drift=0
    §4 history survives reopen  n=153
    §5 second run: no new history rows  before=153 after=153
    §6 upgrade: partial DB 102/153 -> 153/153, marker preserved

Full output: Phase 195 test (32 PASS, 0 FAIL, 0 BLOCKED) after 165/166.

## 7. Restart durability evidence

Phase 196 test §7:

    §7 heartbeat survives reopen       before=1790335111105 after=1790335111105
    §7 progress survives reopen        before=1790335105105 after=1790335105105
    §7 supervision_state survives reopen  got=SUSPECTED_STALL

Real on-disk SQLite, close + reopen via SQLiteEngine.open().

## 8. Idempotency evidence

Phase 195 §5 second-run check: migration runner applied zero new rows on
the second invocation. Checksums still verify. The supervisor pass
`runSupervisionPass` is a pure UPDATE on the same row when the same
stall state is re-detected — no new rows, no event duplication beyond
what the caller chooses to emit.

## 9. Regression evidence

    Phase 126  execution lifecycle            51 / 0
    Phase 194  execution continuity           22 / 0 / 0
    Phase 194  concurrent lease                6 / 0 / 0
    Phase 195  migration integrity            32 / 0 / 0
    Phase 196  execution supervision          30 / 0 / 0
    TypeScript compilation                    exit 0
    Production build                          exit 0 (established at 39e96f8)

## 10. Phase 196 spec coverage — honest accounting

  §1  Inspect before modify               DONE  (commit 39e96f8)
  §2  Preserve Phase 195                  DONE  (no published migration modified)
  §3  Discovery doc                       DONE
  §4  Production supervision model        PARTIAL
        - job/supervision_state/failure_class/supervision_updated_at
        - attempt/heartbeat_at/last_progress_at
        - NOT included: current_stage, current_attempt, last_progress_time
          on execution_jobs (stage is not modeled at execution level)
  §5  Heartbeat / progress supervision    DONE
        - recordHeartbeat, recordProgress, HEARTBEAT_TIMEOUT,
          PROGRESS_TIMEOUT, HEALTHY all implemented and tested
  §6  Supervisor loop                     PARTIAL
        - runSupervisionPass classifies and flags; the existing
          distributed-scheduler already re-queues expired-lease orphans
        - the two are not yet fused into a single tick — Phase 196 test
          exercises runSupervisionPass directly, not via a live scheduler
  §7  Recovery idempotency                EXISTING (Phase 144/175), reused
  §8  Lease + supervisor integration      PARTIAL
        - fencing via EXISTS clause verified
        - shared-mode (Postgres) heartbeat / progress NOT_IMPLEMENTED
          (recordHeartbeat returns SHARED_MODE_NOT_IMPLEMENTED)
  §9  Failure classification              DONE
        HEARTBEAT_TIMEOUT, PROGRESS_TIMEOUT written to failure_class
  §10 Recovery state machine              EXISTING (ExecutionStateMachine), reused
  §11 Operator control                    NOT_IMPLEMENTED for jobs
        - RecoveryControlService targets release intents only
        - no job-level requestRecovery / requestRetry / requestCancellation
  §12 Audit + events                      PARTIAL
        - events: execution.supervision.heartbeat, .progress,
          .stall_detected
        - audit records on heartbeat rejection: NOT_IMPLEMENTED
  §13 Database design                     DONE
  §14 Configuration                       DONE
        - CONFIG.recovery.{heartbeatTimeoutMs, progressTimeoutMs,
          staleAttemptMs}, documented defaults
  §15 Concurrency                         NOT_RUN
        - competing supervisors, heartbeat-vs-timeout race,
          recovery replay, operator-vs-auto — no test in this phase
  §16 Crash / restart                     PARTIAL (restart durability verified;
        crash-during-supervision not simulated)
  §17 Negative tests                      PARTIAL
        - healthy execution not flagged: tested
        - wrong-worker heartbeat rejected: tested
        - terminal execution not classified as running: tested
        - duplicate recovery: NOT tested here (Phase 144/175 cover it)
        - operator action without authorization: N/A (no operator actions)
  §18 Observability                       PARTIAL (durable columns are the
        observability surface; no dedicated diagnostic endpoint added)
  §19 No fake health                      HONORED — classifier returns
        NOT_RUNNING for terminal jobs, NO_ATTEMPT when there is no attempt,
        and never manufactures a HEALTHY verdict
  §20 Test file                           DONE — scripts/test-phase196-execution-supervision.ts
  §21 Regression                          DONE (see §9)
  §22 TSC + build                         DONE
  §23 Evidence doc                        this file
  §24 Production acceptance               NOT FULLY MET — see §11, §15, §12, §18
  §25 Git preservation                    commit + push + tag below

## 11. BLOCKED / NOT_IMPLEMENTED

  Shared-mode (Postgres) heartbeat and progress recording.
    recordHeartbeat and recordProgress return
    { ok: false, reason: "SHARED_MODE_NOT_IMPLEMENTED" } in shared mode.
    Reason: the shared-mode supervisor already exists via
    distributed-scheduler.ts + listStaleAttemptsAsync / fenceStaleAttemptAsync.
    Phase 196 does not add a second shared-mode path.

  Job-level operator actions (§11).
    RecoveryControlService handles release deployment intents. There is no
    job-scoped requestRecovery / requestRetry / requestCancellation.
    The Phase 196 test does not exercise operator control.

  Concurrency matrix (§15).
    No test in this phase covers two supervisors inspecting the same
    attempt, heartbeat racing a supervisor tick, recovery replay, or
    operator racing automatic recovery.

  Audit on heartbeat rejection (§12).
    recordHeartbeat does not write an audit record when the fence rejects.
    It returns { ok: false, reason } but the rejection is not durable.

  Production UI.
    No execution supervision UI exists in the repository. No UI was added.

## 12. Known limitations

  - The Postgres execution_attempts table already had heartbeat_at.
    Migration 165 is a SQLite-only addition; it is a no-op when run
    against Postgres (the migration runner does not run against Postgres
    — pg-bootstrap.ts owns that schema separately).
  - The `ExecutionJobStatus` state machine was not extended. A stalled
    job remains `RUNNING` with supervision_state = SUSPECTED_STALL until
    Phase 194's expired-lease path transitions it through the existing
    ORPHANED → QUEUED / FAILED flow.
  - `staleAttemptMs` defaults to 30_000 (matches Phase 187 Postgres
    partial index threshold). `heartbeatTimeoutMs` defaults to 30_000.
    `progressTimeoutMs` defaults to 300_000. These are conservative and
    may need tuning for real workloads.

## 13. Final commits and tag

  Commits:    39e96f8, 3f8501b, b18ce23, 2a460fe, <test commit>
  Tag:        nexus-phase196-complete (created after this doc is committed)
  Baseline:   f9f2f91 = nexus-phase195-complete (unchanged)
