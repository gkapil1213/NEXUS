# Phase 243 — Retry Scheduling

## Eligibility
listResumableOperations(now = Date.now()) filters:
  (state IN (PENDING, CLAIMED, IN_PROGRESS) OR state = FAILED)
  AND (next_attempt_at IS NULL OR next_attempt_at <= now)

The scheduler tick calls this with default `now`, so Phase 242's next_attempt_at
is honored. Verifier A03 proves both sides (not eligible before, eligible after).

## Backoff
RetryEngine.calculateNextAttempt(attempt, policy, now) with policy
{ initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000, maxAttempts: 5 }:
  attempt 1 -> now + 1000
  attempt 2 -> now + 2000
  attempt 3 -> now + 4000
  attempt 5 -> null (maxAttempts reached)

Phase 242 test verifies the formula. Phase 243 A15 verifies persistence.

## Durability
next_attempt_at and last_failure_class live on execution_recovery_operations.
Verifier A14 proves they survive a docker restart of the Postgres container.
