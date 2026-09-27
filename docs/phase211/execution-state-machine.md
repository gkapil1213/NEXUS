# Phase 211 - Execution State Machine

The state machine is owned by ReleaseIntentStatus in execution-store.ts.
Phase 211 does not add states; it wires the existing transitions behind the
safety gate.

## States (unchanged)

    PENDING | AUTHORIZED | DEPLOYMENT_INTENT_CREATED | DEPLOYING
    | HEALTH_CHECKING | SMOKE_TESTING | VERIFICATION_FAILED
    | ROLLING_BACK | KNOWN_GOOD | FAILED | BLOCKED | CANCELLED
    | RECOVERY_REQUIRED | UNKNOWN

## Transition graph used by Phase 211

    PENDING
      | getOrCreateAsync
      v
    DEPLOYMENT_INTENT_CREATED
      | transitionIfOwnedAsync (fenced, workerId)
      v
    DEPLOYING
      | enforcement.executeRelease()
      +-> KNOWN_GOOD         (provider DEPLOYED/VERIFIED)
      +-> RECOVERY_REQUIRED  (provider UNKNOWN or threw)
      +-> FAILED             (provider NOT_DEPLOYED)
      +-> ROLLING_BACK       (recovery supervisor)
      |
      v (recovery)
    HEALTH_CHECKING -> SMOKE_TESTING -> KNOWN_GOOD | VERIFICATION_FAILED

## Fencing

transitionIfOwnedAsync only succeeds when (a) the caller holds the current
non-expired lease and (b) the intent's current status is in the caller's
expected set. Two workers racing PENDING -> DEPLOYING have exactly one winner.

## Recovery

ReleaseRecoveryExecutor.runOnce() scans RECOVERY_REQUIRED intents, classifies
them with ReleaseRecoveryService, and either re-drives, reconciles via the
provider, or escalates to BLOCKED. Phase 211 does not change this behavior.
