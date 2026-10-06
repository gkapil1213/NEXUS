# Phase 253 - Production Drift to Recovery Handoff Integrity

## Architecture

    DriftObservationSupervisor.runNow()
      -> processDeploymentDriftDurable        (Phase 250/251, unchanged)
      -> handoffDriftIncidentToRecovery       (this phase)
      -> buildProductionRecoveryContext       (Phase 251, unchanged)
      -> requestDriftRecoveryIntent           (Phase 250, unchanged)
      -> ReleaseDeploymentIntentService.getOrCreate (existing)
      -> ReleaseRecoveryExecutor              (existing owner, unchanged)

## Ownership

The drift observer does not own recovery execution.
handoffDriftIncidentToRecovery never:
- executes recovery
- acquires / renews / takes over a recovery lease
- increments recovery_attempt
- calls Docker, the deployment orchestrator, or any provider
- invents identity

## Handoff contract

handoffDriftIncidentToRecovery -> { status, intentKey, reason, incident, updated }

  ACCEPTED     - intent CREATED/RECONCILED; incident correlated
  REJECTED     - bridge refused identity; no intent
  NOT_EXECUTED - no intentService supplied; nothing fabricated

## Idempotency

1. ReleaseDeploymentIntentService.getOrCreateAsync deterministic on input.
2. incident.recovery_intent_key correlation: same key => no update,
   no duplicate RECOVERY_HANDOFF_ACCEPTED timeline event.

## State semantics

DRIFTED      -> incident + handoff
UNKNOWN      -> incident only
BLOCKED      -> incident only
NOT_EXECUTED -> incident only
VERIFIED     -> nothing

## Files

src/core/drift-recovery-handoff.ts        (new)
src/core/drift-observation-supervisor.ts  (intentService dep, handoff call)
src/core/kernel.ts                        (pass releaseIntents)
scripts/test-phase253-recovery-handoff-integrity.ts (new verifier)
package.json, docs/phase253/, artifacts/phase253/

## Limitation

A15 (executor-driven recovery) is out of scope, covered by phases 174-177.
