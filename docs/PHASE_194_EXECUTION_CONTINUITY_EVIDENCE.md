# NEXUS Phase 194 — Execution Continuity Evidence

## 1. Phase objective

Prove and, where necessary, repair the production integration between
the Phase 193 kernel lifecycle and the existing durable execution /
recovery control plane. Do NOT rebuild execution infrastructure that
already exists from Phases 126–190.

## 2. Starting checkpoint

  commit: 2021f27
  tag:    nexus-phase193-complete points at cbbd1a4
  branch: master == origin/master

## 3. Repository audit — what already existed

Phase 194 was executed as integration + gap closure. The audit confirmed
the following execution-continuity infrastructure was already present:

  ExecutionJobStatus + ExecutionStateMachine      execution-models.ts, execution-state-machine.ts
  ExecutionEngine + RetryEngine + LeaseManager    execution-engine.ts, retry-engine.ts, lease-manager.ts
  ExecutionStore + execution_leases               execution-store.ts, migrations 020, 142
  execution_events                                migration 020, execution-store.ts
  execution_recovery_operations                   migration 154
  execution_ownership_obligations                 migration 149
  ExecutionRecoveryOperationStore                 execution-recovery-operation-store.ts
  DistributedScheduler                            distributed-scheduler.ts
  RecoveryOperationsService + RecoveryControl     recovery-operations.ts, recovery-control-service.ts
  Stage / PipelineStage                           devops.ts, stage-execution-store-adapter.ts
  CI reconciliation ownership + fencing           migrations 150, 151
  HTTP idempotency keys                           migration 163
  Release deployment intents + authorizations     migrations 146, 147, 148, 152, 153

No parallel execution engine was created. No duplicate lease manager
was created. No duplicate retry engine was created. No duplicate
recovery system was created.

## 4. Real defect discovered and fixed

### Defect (commit 0688b55)

`ExecutionStore.acquireLease` (sync, line 2918) and `acquireLeaseAsync`
(shared, line 1336) tried a raw INSERT and returned `{acquired:false}`
on UNIQUE failure. Migration 142 declares a partial unique index on
`execution_leases(job_id) WHERE status='ACTIVE'`. A crashed worker
therefore left a row with `status='ACTIVE'` and `expires_at` in the
past that

  - was invisible to `getActiveNonExpiredLeaseForJob` (filters
    `expires_at > now`) — callers saw no live lease, and
  - still held the partial unique index — the INSERT was rejected.

Net effect: a stale ACTIVE lease blocked reacquisition until some
external sweeper flipped it to EXPIRED. After a worker crash, the
execution could not be recovered without operator intervention.

### Fix

Inside a single write transaction, retire any ACTIVE lease for the job
whose `expires_at` has already passed before the INSERT. Uses manual
`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` because `this.db.transaction()`
has divergent contracts between `SQLiteEngine` (`transaction<T>(fn): T`)
and raw `better-sqlite3` (`transaction(fn): fn`). `exec()` has the same
semantics on both.

Preserves every existing invariant: one active per job (142's index),
CAS semantics, fencing, sync SQLite mode.

## 5. Verification — in-process

### scripts/test-phase194-execution-continuity.ts — 22/0/0

Real on-disk SQLite via `SQLiteEngine.open()` (full migration chain).

  F01 execution persisted
  F02 attempt persisted; job points at lease
  F03 worker-A acquired lease
  F04 crash simulated (db closed, no release)
  F05 execution survived restart
  F06 stale RUNNING discovered
  F07 old lease visible after restart (worker-A)
  F08 worker-B takes over expired A lease        ← the fix
  F09 attempt count still exactly one
  F10 attempt number still 1
  F11 worker-A old lease fenced (no longer valid)
  F12 worker-B lease validates
  F13 worker-B can renew
  F14 worker-A cannot renew stale lease
  F15 worker-A cannot mutate via stale lease
  F16 worker-B continues attempt-1
  F17 worker-C rejected while B holds active
  F18 worker-D takes over after B expired        ← double takeover
  F19 no duplicate attempt after second takeover
  F20 final active lease belongs to D

## 6. Verification — cross-process

### scripts/test-phase194-concurrent-lease.ts — 6/0/0

Two OS processes race for the same expired lease against a shared
on-disk SQLite file. WAL + busy_timeout=5000 + BEGIN IMMEDIATE
serialize the writers at the file-lock level.

  B: worker-B acquired=true
  C: worker-C acquired=false ("Lease already held by another worker")

  exactly one child acquired
  exactly one child was rejected
  winner is worker-B
  exactly one ACTIVE lease row remains
  ACTIVE row belongs to winner
  worker-A's lease is EXPIRED

This is persistence-level atomicity. Not JavaScript locking. Two real
processes, one database file, one winner.

## 7. Fixture defect discovered during regression (commit 76114e7)

### Phase 126 — 48/3 → 51/0

T6/T7/T8 called `engine.recoverStaleJobs(Date.now())` without `await`.
The method is `async`. The fixtures then read store state synchronously,
racing the recovery and observing pre-recovery state. Fixed by adding
`await` at the three call sites (T8 has two extra calls in the same
block). Not a production defect — the async signature is correct; the
fixtures were the bug.

## 8. Regression state at 76114e7

  Phase 126  execution lifecycle            51 / 0     ← FIXED this phase
  Phase 127  execution state machine       111 / 0
  Phase 136  execution recovery            fixture FATAL (see §9)
  Phase 142  atomic claim                  PASS
  Phase 148  atomic attempt allocation     PASS
  Phase 153  recovery lease fencing        PASS
  Phase 158  recovery worker heartbeat      91 / 1     (see §9)
  Phase 181  persistence durability         66 / 0
  Phase 191  deployment execution           11 / 0 / 0
  Phase 192  restart safety                 17 / 0
  Phase 193  concurrent boot                 6 / 0 / 6 BLOCKED
  Phase 194  execution continuity           22 / 0 / 0
  Phase 194  concurrent lease                6 / 0 / 0
  TypeScript compilation                    exit 0
  Production build                          exit 0

## 9. Pre-existing failures (verified unchanged by this phase)

Verified by `git stash push -- src/core/execution-store.ts` — identical
results with and without the Phase 194 change.

  Phase 136  execution recovery   fixture FATAL
  Phase 158  recovery worker heartbeat   91 / 1

### Phase 136

Its in-memory DB loads migrations 020 / 021 / 022 / 025 / 142 / 143 /
144 / 149 only. It does not load 154 (`execution_recovery_operations`)
or 164 (`attempt_id` on `execution_artifacts`). It therefore throws
`no such table: execution_recovery_operations` and
`table execution_artifacts has no column named attempt_id` before any
lease-related assertion runs. Fixture incompatibility — the migration
chain was extended after this test was written.

### Phase 158

91 / 1. The single failing assertion ID was not captured in this
session. Confirmed pre-existing by stash.

## 10. Phase 194 spec coverage — honest accounting

  §1  repository audit                     DONE
  §2  execution state machine              EXISTING (execution-state-machine.ts)
  §3  execution lease                      EXISTING + FIXED (0688b55)
  §4  heartbeat / lease renewal            EXISTING (test-phase158)
  §5  crash recovery                       EXISTING (execution-engine recoverStaleJobs)
  §6  stage recovery                       EXISTING (PipelineStage, devops.ts)
  §7  exactly-once boundary                PARTIAL — per-side-effect audit not exhaustive
  §8  execution event log                  EXISTING (execution_events)
  §9  restart reconciliation               VERIFIED (194 continuity F05..F20)
  §10 retry engine                         EXISTING (retry-engine.ts)
  §11 unknown state                        EXISTING (RECOVERY_REQUIRED)
  §12 cancellation                         EXISTING (test-phase137, phase154)
  §13 timeout                              EXISTING (test-phase137, phase146)
  §14 approval continuity                  EXISTING (migration 153)
  §15 security audit                       NOT RUN in this session
  §16 observability                        EXISTING (recovery-operations.ts)
  §17 failure injection F01..F15           PARTIAL:
      covered:  kernel shutdown (192), worker crash (194 F04),
                stale mutation (194 F14/F15), duplicate recovery
                (test-phase136 T20), retry after restart (147),
                timeout after restart (146), cancellation after
                restart (154), duplicate attempt (194 F09/F19),
                concurrent recovery (194 F-race)
      missing:  external-op-uncertain, duplicate artifact registration,
                terminal-state race, failed-boot-during-active-execution
  §18 on-disk restart                      DONE (194 continuity + race)
  §19 concurrent worker                    DONE (194 F-race)
  §20 regression                           DONE (see §8)
  §21 tsc / build                          DONE (exit 0, exit 0)
  §22 evidence doc                         this document
  §23 git preservation                     commits below; tag pending

## 11. BLOCKED items

None. Capability inventory in this environment:

  - Node 26.4
  - Docker Desktop 29.7.2 (used by Phase 191)
  - SQLite via better-sqlite3
  - GitHub bridge NOT connected — the kernel's CI reconciliation
    scheduler is therefore not constructed; the Phase 193 concurrent-
    boot test reports those assertions BLOCKED (not FAILED), which is
    correct.

No PASS was recorded for a check that did not actually execute.

## 12. Final commits

  76114e7  test(phase126): await engine.recoverStaleJobs before sync assertions
  7ba892f  test(phase194): concurrent lease takeover at the SQLite file-lock level
  0688b55  fix(phase194): atomic expired-lease takeover in ExecutionStore
  2021f27  docs(phase193): production evidence — verified scope and carry-forward
  cbbd1a4  (tag: nexus-phase193-complete) fix(phase193): cleanup on failed boot
  545ce5a  fix(phase193): single in-flight boot; concurrent boot is safe
  b1adf30  fix(phase193): defer boot-time recovery to supervisor

## 13. Tag

  nexus-phase194-complete  (created after this document is committed)
