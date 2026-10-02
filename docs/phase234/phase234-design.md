# Phase 234 Design — ACTIVE Deployment Health Observation & Existing Recovery Integration

## 1. Existing health architecture discovered
- `TrafficRouter.health(targetId)` with `RouterHealthVerdict = HEALTHY | UNHEALTHY | UNKNOWN | BLOCKED`.
- `AWSTrafficRouter.health()` performs real `aws elbv2 describe-target-health`.
- `NoopTrafficRouter.health()` returns `BLOCKED / NO_TRAFFIC_ROUTER_CONFIGURED`.
- `ReleaseRecoveryService.classify()` maps `HEALTH_DEGRADED` to `RECOVERY_REQUIRED`.

## 2. Why no new health framework was required
All primitives needed for subsequent ACTIVE-state observation already existed.

## 3. Exact integration point selected
`DeploymentActivationService.observeActiveHealth(intentKey, workerId)` — a method
on the class that already owns ACTIVE. Reuses existing lease + fenced CAS primitives.

## 4. ACTIVE → HEALTH_DEGRADED semantics
`UNHEALTHY` triggers `transitionIfOwnedAsync(intentKey, "HEALTH_DEGRADED", workerId, {...}, ["ACTIVE"])`.
No automatic rollback.

## 5. UNKNOWN / BLOCKED semantics
Neither transitions state; evidence persisted via same-status fenced transition.
Provider reason preserved verbatim.

## 6. Provider target identity binding
`providerTargetId` = `intent.providerDeploymentId`, written earlier by
`DeploymentActivationService.activate()` from the real cutover result.

## 7. Lease / stale-worker protection
`acquireLeaseAsync` gates entry; `transitionIfOwnedAsync` refuses stale workers;
`releaseLeaseAsync` on exit.

## 8. Durable evidence mechanism
JSON document written into `release_deployment_intents.reconciliation_evidence`.
No new table; no secrets.

## 9. Existing recovery integration
`HEALTH_DEGRADED` -> existing `ReleaseRecoveryService.classify` -> `RECOVERY_REQUIRED`.

## 10. Why automatic rollback was not introduced
Policy per Phase 227: `HEALTH_DEGRADED -> operator review`. Observation is not recovery.

## 11. Test results (actual)
- Phase 231: PASS 17 / FAIL 0 / BLOCKED 1 / NOT EXECUTED 0
- Phase 232: PASS 16 / FAIL 0 / BLOCKED 0 / NOT EXECUTED 0
- Phase 233: PASS 16 / FAIL 0 / BLOCKED 1 / NOT EXECUTED 0
- Phase 234: PASS 30 / FAIL 0 / BLOCKED 1 / NOT EXECUTED 0
- `npx tsc --noEmit`: exit 0
- `git diff --check`: clean

## 12. Real provider limitations
`234R BLOCKED :: AWS_REGION_NOT_CONFIGURED` — honest environment limitation,
not counted as PASS.
