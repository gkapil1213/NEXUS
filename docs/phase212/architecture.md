# Phase 212 - Architecture

Phase 212 verifies and hardens the EXISTING release recovery path. It does
not add a recovery engine, state machine, or provider abstraction. The
recovery infrastructure was built across Phases 103, 104, 119, 173-179,
and 183; Phase 212 proves it composes with the Phase 211 release execution
gate against real PostgreSQL.

## Components verified (all pre-existing)

- src/core/release-recovery.ts             - pure classifier
- src/core/release-recovery-executor.ts    - supervised recovery runner
- src/core/release-recovery-inspection.ts  - container/image inspection
- src/core/release-recovery-decision.ts    - recovery decision envelope
- src/core/release-deployment-intent.ts    - durable intent + lease + fenced transitions
- src/core/distributed-scheduler.ts        - recovery scheduling
- execution_recovery_operations table      - durable recovery ops (Phase 144)

## What Phase 212 adds

Nothing in production code. Phase 212 is verification + evidence + docs.

## Recovery flow (verified by 212A-212AF)

    intent in DEPLOYING
      | ReleaseRecoveryService.classify()
      v
    RECOVERY_REQUIRED (inspection required)
      | acquireLease(intentKey, workerId, ttl)
      | provider.reconcile()
      v
    provider status mapped to NEXUS intent state
      | transitionIfOwnedAsync(fenced by workerId)
      v
    KNOWN_GOOD | VERIFICATION_FAILED | FAILED | BLOCKED

## Fencing

All mutating transitions go through transitionIfOwnedAsync(intentKey,
status, workerId, ...), which requires: (a) the caller holds the current
non-expired lease, (b) intent status is in the caller's expected set. Two
workers racing the same transition have exactly one winner.
