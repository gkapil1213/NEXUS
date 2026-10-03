# Phase 243 — Failure Recovery

## Classification (Phase 242, reused)
classifyOperationFailure(errMsg) -> RETRYABLE | NON_RETRYABLE | PERSISTENCE_UNAVAILABLE
Ordered: PERSISTENCE_UNAVAILABLE patterns first, then NON_RETRYABLE, then RETRYABLE.
Default for unknown -> NON_RETRYABLE (safe; prevents retry storms).

## Non-retryable path
- markFailed with failureClass = NON_RETRYABLE and nextAttemptAt = null.
- Row excluded from listResumableOperations forever.
- Verifier A16 asserts both persisted class and null next_attempt_at.

## Persistence-unavailable
- Kept distinct from application-level failure (spec §3).
- Kernel boot fails loudly if shared mode cannot reach Postgres.

## Maximum attempts
- reconcileExecutionRecoveryOperations escalates FAILED with attemptCount >= 5
  to RECOVERY_REQUIRED. Verifier A15 drives 5 failed attempts and confirms.
