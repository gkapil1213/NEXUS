# Phase 211 - Architecture

Phase 211 composes existing release/deployment infrastructure behind an
evidence-backed execution gate. It does not create a second scheduler, lease
manager, deployment provider, or state machine. It hardens and wires.

## Components

New:
- src/core/release-execution-gate.ts   - composer + fail-closed execution gate
- scripts/test-phase211-release-execution.ts
- scripts/phase211-evidence.ts

Reused (unchanged interfaces):
- src/core/release-safety-gate.ts      - Phase 210 evidence-backed authorization
- src/core/release-deployment-intent.ts - deterministic intent + lease + fenced transitions
- src/core/production-release-enforcement.ts - durable authorization + provider
- src/core/release-recovery-executor.ts - supervised recovery of RECOVERY_REQUIRED intents

## Production fix uncovered by Phase 211

production-release-enforcement.ts executeRelease() read attempt and job via
getAttempt()/getJob() synchronous methods. In shared (Postgres) mode those
hit the empty SQLite mirror and every execution returned BLOCKED. Fixed to
prefer getAttemptAsync()/getJobAsync() when store.hasAsyncBackend(). This was
a real production bug: any release execution through the enforcement service
in shared mode was silently blocked.

## Execution flow

    ReleaseExecutionGate.execute()
      1. evaluateReleaseSafety(candidate, verificationRun, policy)   [Phase 210]
         ALLOWED ? continue : REJECTED_*
      2. intents.getOrCreateAsync()          - idempotent durable intent
      3. intents.getAsync()                  - refuse if already past PENDING
      4. intents.acquireLeaseAsync()         - distributed lease
      5. intents.transitionIfOwnedAsync(     - fenced CAS PENDING -> DEPLOYING
           DEPLOYING, workerId, {}, [PENDING, AUTHORIZED, DEPLOYMENT_INTENT_CREATED])
      6. enforcement.executeRelease()        - durable auth + provider
      7. intents.transitionIfOwnedAsync(     - fenced terminal transition
           KNOWN_GOOD | RECOVERY_REQUIRED | FAILED, workerId, {}, [DEPLOYING])
      8. releaseLeaseAsync()

Steps 5 and 7 are the concurrency guarantee: exactly one worker can advance
the intent through DEPLOYING; losers return BLOCKED with no side effects.
