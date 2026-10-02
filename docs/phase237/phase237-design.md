# NEXUS Phase 237 — Fair Active-Health Observation Coverage

## Objective

Prevent starvation when the number of ACTIVE release deployment intents exceeds the
per-tick active-health observation cap.

## Implementation

Phase 237 extends the existing Phase 236 active-health lifecycle. It does not create
another scheduler, recovery engine, or timer.

The intent store now exposes keyset pagination:

`listActiveIntentsAfterCursorAsync(afterIntentKey, limit, environment?)`

The query orders ACTIVE intents by `intent_key ASC` and uses:

`intent_key > cursor`

instead of offset pagination.

The existing `ReleaseRecoverySupervisor` maintains an in-memory active-health cursor.
Each tick requests `cap + 1` rows:

- more than `cap`: observe `cap` intents and advance the cursor;
- `cap` or fewer: observe the available intents and wrap to the beginning.

The active-health phase remains bounded and sequential and continues to use the existing
`DeploymentActivationService.observeActiveHealth()` lease/fencing behavior.

## Restart Semantics

The cursor is intentionally in-memory. A new supervisor starts from the beginning of
the ACTIVE keyspace.

The cursor is scheduling state, not authoritative deployment state. Deployment health,
intent status, leases, and evidence remain persisted through the existing production
state mechanisms.

## Preserved Architecture

Phase 237 does not replace:

- ReleaseRecoverySupervisor
- ReleaseRecoveryExecutor
- DeploymentActivationService
- existing recovery classification
- existing lease/fencing behavior
- existing deployment state transitions

## Verification

Phase 237 direct verification:

- PASS: 23
- FAIL: 0
- BLOCKED: 0
- NOT EXECUTED: 0

Phase 235 regression:

- PASS: 35
- FAIL: 0
- BLOCKED: 0
- NOT EXECUTED: 0

Phase 236 regression:

- PASS: 25
- FAIL: 0
- BLOCKED: 0
- NOT EXECUTED: 0

Important verified scale scenario:

55 ACTIVE intents were tested with a cap of 10 and all 55 were eventually observed
across multiple ticks.

The later redirected-output capture attempts were interrupted and removed. They are
not considered verification evidence.

The Node DEP0190 deprecation warning was non-failing.

No destructive database reset was used.
