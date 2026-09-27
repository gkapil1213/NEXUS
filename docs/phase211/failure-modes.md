# Phase 211 - Failure Modes

## Fail-closed rules

| Condition | Detection | Outcome |
|---|---|---|
| Phase 210 gate returns !ALLOWED | evaluateReleaseSafety | REJECTED_* |
| Intent already past PENDING | intents.getAsync() | BLOCKED (intent_already_*) |
| Lease held by another worker | acquireLeaseAsync | BLOCKED (lease_held_by) |
| Fenced transition race lost | transitionIfOwnedAsync | BLOCKED (race_lost) |
| No provider configured | enforcement.executeRelease | BLOCKED (no provider) |
| Provider threw | executeRelease catch | NOT_EXECUTED (outcome unknown) |
| Provider NOT_DEPLOYED | executeRelease return | BLOCKED |
| Provider UNKNOWN | executeRelease return | NOT_EXECUTED |
| Attempt/job not durable | executeRelease pre-flight | BLOCKED |
| Attempt belongs to different release | executeRelease pre-flight | BLOCKED |
| Authorization not found/expired/revoked | authorizeExecution | BLOCKED |
| Authorization consumed by another attempt | authorizeExecution | BLOCKED (replay) |

## Process restart safety

All intent, lease, and authorization state is durable. A restart between any
two steps in the gate does not lose the intent; the recovery supervisor scans
RECOVERY_REQUIRED intents and re-drives them.

## Concurrency

The single authoritative transition into DEPLOYING is gated by both the
distributed lease and a fenced CAS on intent status. Both must pass; a
loser returns BLOCKED with no side effects. Verified by 211G (2 workers)
and 211Z (3 workers).

## Not implemented in Phase 211

- Real Kubernetes / SSH / cloud provider adapters (not present in this repo)
- Provider-specific status reconciliation beyond the ReleaseExecutionProvider
  .reconcile() interface already provided by Phase 173
- Dashboard UI (out of scope)
