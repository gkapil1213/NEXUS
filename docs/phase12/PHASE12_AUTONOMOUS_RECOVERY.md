# Phase 12: Autonomous Recovery Orchestration

## Overview
Phase 12 extends Phase 11 with a full recovery lifecycle orchestrator, verification step, retry enforcement, idempotency, and audit evidence.

## Key Components
- **RecoveryOrchestrator** (`src/core/recovery-orchestrator.ts`): Coordinates incident → decision → execution → verification → final state.
- **RecoveryVerifier** (`src/core/recovery-verifier.ts`): Interface and simple predicate-based health check.
- **RecoveryAttemptRecord**: Persisted in `recovery_attempts` table (migration 020).
- **Idempotency**: Unique `idempotency_key` prevents duplicate attempts.

## Lifecycle States
`DETECTED, ANALYZING, DECIDING, APPROVED, EXECUTING, VERIFYING, RECOVERED, FAILED, BLOCKED, HUMAN_REVIEW_REQUIRED`

## Verification
A recovery action is considered successful only if both execution and independent verification succeed.

## Testing
Run:
```bash
npx tsx scripts/run-phase12-pass1.ts