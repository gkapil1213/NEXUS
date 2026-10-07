# Phase 254 - Production Recovery Completion & Post-Recovery Integrity Closure

## Objective

Close the gap where ReleaseRecoveryExecutor transitions a durable intent to
KNOWN_GOOD but never re-observes the deployment or resolves the correlated
incident.

## Architecture

    ReleaseRecoveryExecutor.runOnce()            (existing)
      - owns lease, provider execution, rollback, attempts, retries
            |
            v (KNOWN_GOOD)
    RecoveryCompletionReconciler (this phase)
      - correlated incident lookup by recovery_intent_key
      - history.getDeployment()
      - DockerDeploymentObserver.observe()       (existing)
      - evaluateDeploymentIntegrity()            (Phase 249, unchanged)
      - evaluateIncidentResolution()             (Phase 250, unchanged)
      - applyResolutionIfVerified()              (Phase 251, unchanged)
      - closeIncidentIfResolved()                (Phase 251, unchanged)
            |
            v
    durable RESOLVED / CLOSED, or remain unresolved

## Ownership boundaries

The reconciler never:
- acquires / renews / releases a lease
- transitions intents
- increments recovery_attempt
- calls Docker directly
- fabricates observations or identity

The ReleaseRecoveryExecutor remains the sole recovery authority.

## Resolution contract

    Fresh VERIFIED observation            -> RESOLVED_ALLOWED
    Fresh DRIFTED / UNKNOWN / BLOCKED /   -> not allowed
      NOT_EXECUTED
    Stale VERIFIED (or invalid timestamp) -> STALE_OBSERVATION, not allowed

## Durable state

No new migration. No schema change. No second store.
- security_incidents.recovery_intent_key (correlation)
- security_incidents.status              (RESOLVED, then CLOSED)
- security_incidents.verification_state  (VERIFIED)
- security_incidents.resolution_evidence (JSON evidence)
- security_incidents.resolved_at / closed_at
- security_incident_timeline events

## Idempotency

- RESOLVED or CLOSED incidents are skipped on subsequent passes.
- applyResolutionIfVerified is idempotent on terminal status.
- Two concurrent reconcilers produce exactly one authoritative resolution (A11).

## Failure semantics

| Case | Result |
|---|---|
| Fresh VERIFIED | RESOLVED -> CLOSED |
| Fresh DRIFTED / UNKNOWN / BLOCKED / NOT_EXECUTED | remain unresolved |
| Stale observation | STALE_OBSERVATION, remain unresolved |
| No correlated incident | skippedNoIncident |
| Observer throws | errors[], no resolution |

## BLOCKED / NOT EXECUTED

- A17 (live Docker deployment + real observer end-to-end): NOT EXECUTED.
  Reason: covered by Phase 250 A21 live test and Phases 174-177.

## No second recovery executor. No second incident store. No SQLite fallback.
## No fake VERIFIED state.
