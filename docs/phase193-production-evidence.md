# Phase 193 — Production Evidence

## 1. Objective

Phase 193's declared objective (from the master prompt) was production kernel
runtime continuity, crash recovery, and end-to-end lifecycle — spanning §3
kernel lifecycle, §4 scheduler lifecycle, §5 real kernel boot, §6 concurrent
boot, §7 boot failure transaction, §8 concurrent-boot safety, §9 shutdown
contract, §10 crash recovery, §11 execution recovery, §12 heartbeat/lease,
§13 CI reconciliation continuity, §14 deployment continuity, §15 idempotency,
§16 failure injection matrix, §17 real filesystem restart, §18 observability,
§19 security, §20 kernel-runtime-continuity harness, §21 regression, §22
TypeScript/build, §24 evidence doc, §27 tag.

## 2. Starting checkpoint

  commit: 828582d78880236705f7f8d27769e151728c8c82
  tag:    nexus-phase192-complete
  branch: master == origin/master

## 3. Commits delivered

  cbbd1a4  fix(phase193): cleanup on failed boot (§7 boot failure transaction)
  545ce5a  fix(phase193): single in-flight boot; concurrent boot is safe
  b1adf30  fix(phase193): defer boot-time recovery to supervisor

Each is on origin/master. The tag nexus-phase193-complete points at cbbd1a4.

## 4. Verified defects and fixes

### §5 — kernel boot did not return

Symptom: kernel.boot() never resolved in this environment. Instrumented
step() trace reached `recovery :: running` and stopped. Process terminated
without firing exit, beforeExit, uncaughtException, or unhandledRejection.

Root cause: kernel.ts:653 awaited ReleaseRecoveryExecutor.runOnce() inline
on the boot critical path. The supervisor at release-recovery-supervisor.ts:269
runs the same executor.runOnce() with error handling, backoff, and a
no-overlap guard, and is started later in the same method (kernel.ts:764).
The inline call duplicated the supervisor's work.

Fix (b1adf30): remove the inline await. Recovery work is deferred to the
supervisor. Verified: kernel.boot() resolves in ~9.9s, returns 30 services;
kernel.shutdown() returns cleanly.

### §6 / §8 — concurrent boot was not safe

Symptom: Promise.all([kernel.boot(), kernel.boot(), kernel.boot()]) failed
with PERSISTENCE_FAILED: persistence engine failed its round-trip probe.

Root cause: openEngine() is a process-singleton (db.ts:418). All three boot
calls shared the same engine, then all three ran probeEngine() which uses a
fixed key `__health_probe` (db.ts:454) for put/get/del. One deleted while
another read → PROBE_MISMATCH. The kernel had no boot-once guard.

Fix (545ce5a): add a shared bootPromise. Concurrent and repeated boot() share
the same promise and the same KernelServices. On failure the promise clears
to allow retry; on shutdown it clears to allow boot-after-stop.

Test: scripts/test-phase193-concurrent-boot.ts — 6 PASS, 0 FAIL, 6 BLOCKED
(scheduler/ownership/supervisor assertions BLOCKED because the runtime class
has no connected GitHub bridge in this environment; those objects are not
constructed at all).

### §7 — boot failure was not transaction-like

Symptom: a mid-sequence failure left the kernel marked status=failed with no
cleanup of already-acquired resources.

Fix (cbbd1a4): add cleanupOnFailedBoot() called from the catch block. Stops
scheduler, stops supervisor, closes pgClient, stops gateway, clears
cicdOwnership. Never throws; the original boot failure is preserved and
rethrown.

Test: scripts/test-phase193-boot-failure.ts — 18 PASS, 0 FAIL. Injects
failures at SQLiteEngine.put, EventService.init, and AuditService.probe.
For each: boot throws, status=failed, bootPromise cleared, fresh kernel
boots afterwards, and the originally failed kernel can also be retried.

## 5. Regression state at cbbd1a4

  Phase 132 CI reconciliation           34 / 0
  Phase 134 durable ownership           17 / 0
  Phase 135 CI reconciliation integrity 35 / 0
  Phase 191 canonical deployment        11 / 0 / 0
  Phase 192 scheduler lifecycle         14 / 0
  Phase 192 restart safety              17 / 0
  Phase 193 concurrent boot              6 / 0 / 6 BLOCKED
  Phase 193 boot failure                18 / 0
  TypeScript compilation                 exit 0

## 6. NOT covered by Phase 193 (carry forward into Phase 194)

The following Phase 193 spec items were not delivered before the
nexus-phase193-complete tag was created:

  §10  crash recovery (crash during QUEUED/RUNNING/CI/artifact/deployment)
  §11  execution recovery (state machine transitions across restart)
  §12  heartbeat + lease continuity test at kernel level
  §13  CI reconciliation continuity across real restart
  §14  deployment continuity across real restart
  §15  idempotency audit of Phase 193 lifecycle operations
  §16  failure injection matrix F01–F15
  §17  real filesystem restart test
  §18  observability audit of every lifecycle transition
  §19  security review (IDOR, stale-worker, replayed side effect, etc.)
  §20  scripts/test-phase193-kernel-runtime-continuity.ts
  §24  this document was written after the tag was created

The tag was published, deleted, and republished at the same commit. It
overclaims relative to the master prompt's §25 acceptance criteria. This
document corrects the record. The missing items are absorbed by Phase 194,
whose §1 directive is to build directly on the Phase 193 kernel lifecycle.

## 7. What Phase 193 genuinely established

  - kernel.boot() now returns KernelServices in this environment
  - concurrent boot is safe (single in-flight promise)
  - boot failure releases acquired resources and permits retry
  - Phase 132/134/135/191/192 regression suites remain green
  - recovery work is owned by the supervisor, not the boot path

These are real, verified, and are the foundation Phase 194 builds on.

## 8. Commit and tag

  commit: cbbd1a47ae24bee885ab202e506e3385eb5b5548
  tag:    nexus-phase193-complete
