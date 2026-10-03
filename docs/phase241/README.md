# Phase 241 — Durable Execution Recovery Claim Renewal & Crash-Safe Watchdog

## Problem
Recovery body longer than the 60s claim TTL loses its durable claim mid-execution; another worker could claim and run the same operation concurrently.

## Reused infrastructure
- Table: execution_recovery_operations
- Stores: ExecutionRecoveryOperationStore (sync) + AsyncExecutionRecoveryOperationStore (async)
- Method: renewOperationClaim() (sync existed; async sibling added)
- Scheduler: NexusKernel.recoverStaleJobs() (unchanged)
- Engine: ExecutionEngine.runRecoveryOperationAsync() (watchdog wired in)
- Hooks: __testPhase144Hook preserved; __testPhase241Hook and __testPhase241WatchdogIntervalMs added

## Watchdog
startRecoveryClaimWatchdog() starts after markInProgress(). Interval = claimDuration/3 (default 20s), unref'd, non-overlapping renewals, stop() clears timer, try/finally around body().

Renewal result classification:
- RENEWED -> continue
- OWNERSHIP_LOST / EXPIRED / NOT_FOUND / TERMINAL -> ownershipLost flag; body result not success
- persistence error -> fenced markCompleted decides

## Sync SQLite limitation
Fully blocking sync body cannot yield to a timer. 241T verifies sync semantics via isolated in-memory better-sqlite3.

## No new infrastructure
No new journal/lease/scheduler/recovery engine. Phase 239/240 unchanged.

## Results
Phase 241: PASS 44 / FAIL 0 / BLOCKED 0 / NOT EXECUTED 0
Phase 235-240 regressions: baseline
TypeScript: exit 0
git diff --check: clean

## Known limitations
- Sync blocking recovery cannot renew via timer.
- AWS_REGION_NOT_CONFIGURED remains BLOCKED.
- Vite browser-boundary build failure remains unrelated.