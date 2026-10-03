# Phase 242 — Durable Retry Orchestration & Failure Classification

## Objective
Extend the Phase 241 execution-recovery operation model with durable,
deterministic failure classification and bounded retry scheduling. No new
retry engine, no new scheduler, no second operation store.

## What was added
- `src/core/operation-failure-classification.ts` — pure classifier
  returning RETRYABLE / NON_RETRYABLE / PERSISTENCE_UNAVAILABLE.
- Two additive columns on `execution_recovery_operations`:
  `next_attempt_at BIGINT`, `last_failure_class TEXT`.
- Index `idx_ero_next_attempt (state, next_attempt_at)`.
- `markFailed(...)` extended in both stores to accept
  `{ failureClass?, nextAttemptAt? }` — defaults preserve Phase 241 behavior.
- `listResumableOperations(now)` now filters by `next_attempt_at IS NULL OR
  next_attempt_at <= ?`.
- Async retry orchestration path in `ExecutionEngine.runRecoveryOperationAsync`
  classifies the error and persists retry metadata on FAILED transitions.

## Failure classification
Deterministic pattern-based classifier. Order of precedence:
1. PERSISTENCE_UNAVAILABLE (ECONNREFUSED, ECONNRESET, timeouts at the
   connection layer, explicit PERSISTENCE_UNAVAILABLE markers).
2. NON_RETRYABLE (VALIDATION_FAILED, UNAUTHORIZED, FORBIDDEN, invalid input,
   unsupported operations).
3. RETRYABLE (TIMEOUT, temporarily unavailable, 429, 503, 504, transient
   server errors).
4. Anything unrecognized defaults to NON_RETRYABLE — avoids retry storms.

## Retry metadata
- `next_attempt_at` = absolute time (ms) when the operation becomes eligible.
- `last_failure_class` = one of the three classification values.
- Both nullable. NULL `next_attempt_at` on FAILED means "not eligible for
  automatic retry" (terminal or manual).
- Persisted durably via `markFailed` on the same `execution_recovery_operations`
  table used by Phase 241 — no new table.

## Backoff policy
Reuses the existing `RetryEngine.calculateNextAttempt` with the standard
policy shape (`initialDelayMs`, `multiplier`, `maxDelayMs`, `maxAttempts`).
Pure / deterministic / bounded: verified in 242C.

## Fencing
Retry scheduling is fenced by the same Phase 241 CAS rules:
- `markFailed` requires an unexpired claim and matching `claim_owner`.
- Stale workers cannot persist retry metadata for newer attempts.
- Metadata is durable across reload / restart.

## Attempt accounting
Unchanged from Phase 241: `attempt_count` increments only on successful
`claimOperation`. Renew, scheduling, and duplicate scheduling do not
increment it.

## No new infrastructure
- No new scheduler (existing `NexusKernel.recoverStaleJobs()` loop remains).
- No new retry engine (`RetryEngine` reused).
- No new operation table (`execution_recovery_operations` reused).
- No second classification system (one classifier module, distinct from
  provider-level and deployment-level classifications that already existed).

## Results (actual)
Phase 242: PASS 30 / FAIL 0 / BLOCKED 0 / NOT EXECUTED 0
Phase 239 regression: PASS 56 / FAIL 0
Phase 240 regression: PASS 25 / FAIL 0
Phase 241 regression: PASS 44 / FAIL 0
TypeScript: exit 0
git diff --check: clean

## Known limitations
- SQLite and shared/Postgres both go through the same store code, but this
  Phase 242 test exercises the shared path. The sync SQLite path is
  exercised by the Phase 241 241T test.
- AWS_REGION_NOT_CONFIGURED remains BLOCKED for real-AWS paths (unrelated).
- The Vite browser-boundary build failure remains unrelated to Phase 242.