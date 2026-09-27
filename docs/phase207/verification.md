# Phase 207 - Verification

## TypeScript

npx tsc --noEmit --pretty false -> exit 0.

## Phase 207 test

npx tsx scripts/test-phase207-production-scheduler.ts

### sqlite mode (default)

    PASS:        4   (207A, 207B, 207C, 207F)
    FAIL:        0
    BLOCKED:    16   (207D, 207E, 207G-207T)
    NOT EXECUTED: 0

### shared mode (NEXUS_PERSISTENCE_MODE=shared, DATABASE_URL set)

    PASS:        7   (207A, 207B, 207C, 207D, 207E, 207G, 207N)
    FAIL:        0
    BLOCKED:     0
    NOT EXECUTED: 13  (207F, 207H-207M, 207O-207T)

Interpretation:

- 207A: kernel.boot() completes in either mode.
- 207B: pre-start status is wired=false, running=false.
- 207C: sqlite mode rejects start with SCHEDULER_REQUIRES_SHARED; shared
  mode starts successfully.
- 207D: idempotent start (running=true after two calls).
- 207E: DistributedScheduler constructed with the kernel's real store.
- 207F: sync recoverStaleJobs path (sqlite only).
- 207G-207T require seeded durable jobs and/or a real worker adapter.
  They report NOT EXECUTED rather than PASS.

## Shared-mode smoke

    BOOT_OK
    hasAsyncBackend= true
    SCHEDULER_STATUS= { wired: true, running: true, ... }
    smoke=0

## Regression

Existing phase scripts under scripts/ run separately. See the phase 207
evidence artifact for the current run.
