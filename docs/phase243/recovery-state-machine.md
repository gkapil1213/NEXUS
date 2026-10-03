# Phase 243 — Recovery State Machine

## States (existing; no new states added)
PENDING -> CLAIMED -> IN_PROGRESS -> COMPLETED
                  \-> FAILED -> (retry eligible | RECOVERY_REQUIRED)
                  \-> CANCELLED
                  \-> RECOVERY_REQUIRED (operator signal; not auto-retried)

## Transitions used by Phase 243
- createOrGetOperation -> PENDING (idempotent on idempotency_key)
- claimOperation -> CLAIMED (CAS: only PENDING|FAILED|RECOVERY_REQUIRED|expired claim)
- markInProgress -> IN_PROGRESS
- markFailed(err, { failureClass, nextAttemptAt }) -> FAILED
  - RETRYABLE: next_attempt_at = now + backoff
  - NON_RETRYABLE: next_attempt_at = NULL (terminal for auto-retry)
- markCompleted -> COMPLETED (owner-fenced)
- markRecoveryRequired -> RECOVERY_REQUIRED (auto-retry excluded)

## Terminal rules
- attemptCount >= 5 with FAILED escalates to RECOVERY_REQUIRED on next reconcile.
- NON_RETRYABLE rows have next_attempt_at = NULL and are excluded from
  listResumableOperations.
- No terminal state is ever overwritten by a stale owner.
