# Phase 244 — Crash-Safe End-to-End Execution Lifecycle Orchestration

## Objective
Prove the existing execution/recovery lifecycle is crash-safe end-to-end
against real PostgreSQL: no duplicate authoritative execution, no stale-owner
mutation, no resurrection of terminal state, no double finalization.

## Implementation
Verification-first. No new production code, no new scheduler, no new recovery
engine, no new lease table.

Added:
- `scripts/test-phase244-crash-safe-execution-lifecycle.ts` (verifier, A01–A25)
- `scripts/_phase244_lifecycle_child.ts` (child-process driver)
- `src/db/migrations/173_phase242_recovery_retry_metadata.sql` (SQLite parity
  for Phase 242's `next_attempt_at` / `last_failure_class` — closes a real
  schema-drift regression that had been failing Phase 241 test 241T)

## Lifecycle
QUEUED -> ADMITTED -> CLAIMED -> RUNNING -> VERIFYING -> terminal
(SUCCEEDED | FAILED | CANCELLED | DEAD_LETTER | BLOCKED)

No FINALIZING state exists in the repository model; finalization is a
CAS-fenced transition from any non-terminal status driven by
`finalizeExecution` / `finalizeExecutionAsync`.

## Finalization
`execution-finalizer.ts` already:
- treats terminal status as `ALREADY_TERMINAL` no-op
- performs `recoverJobAtomic({expectedStatus, expectedLeaseId: null})` CAS
- rechecks for terminal on CAS loss

Shared-mode callers route to `finalizeExecutionAsync` (execution-engine.ts:2005);
local/SQLite callers use `finalizeExecution` (:2013).

## Lease expiry / replacement
`atomicClaimJobAsync` fences by `(status, current_lease_id)` and refuses a
second ACTIVE lease via the partial unique index. When a lease expires, the
job is moved back to a claimable state by `recoverStaleJobs` ->
`recoverExpiredLeasesAsync`; only then can a replacement claim.

## Concurrency
Verified with real child processes: 4-way concurrent claim (A05) — exactly
one winner; concurrent recovery scan (A19/A20) — no duplicate ORPHAN_RECOVERY
op, no duplicate ACTIVE lease.

## PostgreSQL restart
A18 stops and restarts `nexus-pg` mid-test; job status survives, reconnect
succeeds, no state loss.

## Results
Phase 244: PASS 41 / FAIL 0 / BLOCKED 0 / NOT EXECUTED 0
Phase 243: PASS 39; Phase 242: PASS 30; Phase 241: PASS 44;
Phase 240: PASS 25; Phase 239: PASS 56
TypeScript: exit 0
git diff --check: clean

## Known limitations
- `recoverStaleJobs` requires recovery to run before a replacement worker
  can claim an expired-lease job (recovery resets CLAIMED -> QUEUED). This is
  the intended flow; verifier A06/A08 both drive recovery explicitly.
- AWS_REGION_NOT_CONFIGURED remains BLOCKED for real-AWS paths (unrelated).
- Pre-existing Vite browser-boundary build failure unrelated.
