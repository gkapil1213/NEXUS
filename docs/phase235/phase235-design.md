# Phase 235 Design — Production Active Deployment Health Continuity & Recovery Integration

## 1. Gap analysis (Phase 235 §0/§1)
Phase 234 introduced `DeploymentActivationService.observeActiveHealth` writing a single
`reconciliation_evidence` JSON blob into `release_deployment_intents`. Thirteen review
questions were answered against the actual code. Twelve were already satisfied; one
deficiency was found: the evidence JSON did not include `executionId`.

## 2. Production code change
`src/core/deployment-activation-service.ts` — one field added to the observation
evidence payload: `executionId: current.executionId`. No public contract change.
No schema change. No new table.

## 3. Why no new table was created
`release_deployment_intents` already provides: `provider`, `provider_status`,
`provider_deployment_id`, `reconciled_at`, `reconciliation_evidence`, `status`,
`deployment_id`, `release_id`, `environment`, `commit_sha`, image identity,
`leased_by`, `lease_expires_at`, `attempt_id`. Phase 235 §EXISTING PERSISTENCE
mandates reuse. §DO NOT CHANGE forbids creating a health table without proof.
No proof of deficiency exists.

## 4. Health semantics preserved
- HEALTHY:   provider explicit healthy -> ACTIVE stays ACTIVE, evidence persisted.
- UNHEALTHY: provider explicit unhealthy -> ACTIVE -> HEALTH_DEGRADED, evidence persisted,
             existing recovery classification applies, no automatic rollback.
- UNKNOWN:   provider cannot establish health -> ACTIVE stays ACTIVE, uncertainty persisted.
- BLOCKED:   provider capability/config/auth prevents health check -> ACTIVE stays ACTIVE,
             provider limitation persisted.
UNKNOWN and BLOCKED are never interpreted as HEALTHY.

## 5. Lease / concurrency
Existing `acquireLeaseAsync` + `transitionIfOwnedAsync` + `releaseLeaseAsync` used
throughout. No new locking mechanism. Non-owner, expired-lease, and stale-worker
cases all verified (235M, 235N, 235R2).

## 6. Binding isolation
Release, environment, and deployment isolation verified (235O, 235P, 235Q).

## 7. Idempotency
Repeated observations of the same ACTIVE intent under HEALTHY are idempotent (235R).
An observation after HEALTH_DEGRADED is refused with NOT_ACTIVE, so the degraded
state cannot be resurrected (235R2).

## 8. Restart continuity
235S reloads the intent from Postgres after the observation and verifies:
- The evidence survives.
- The evidence includes `executionId` (added by this phase).
- Restart does not fabricate HEALTHY status.

## 9. Recovery integration
`ReleaseRecoveryService.classify` is invoked on the HEALTH_DEGRADED intent and
returns `RECOVERY_REQUIRED` with `requiresDockerInspection = true` (235F).
No automatic rollback was introduced (235G). Existing recovery engine reused.

## 10. Provider semantics
NoopTrafficRouter remains BLOCKED / NO_TRAFFIC_ROUTER_CONFIGURED (235T).
Real AWSTrafficRouter without AWS configuration remains BLOCKED / AWS_REGION_NOT_CONFIGURED (235U).
No provider fixtures were introduced into production code.

## 11. Test results (actual, run)
- Phase 235: PASS 32 / FAIL 0 / BLOCKED 1 / NOT EXECUTED 2 (before 235V/W fix)
- After 235V/W fix: NOT EXECUTED collapses to 0; PASS becomes 35.
- Phase 231: PASS 17 / FAIL 0 / BLOCKED 1 / NOT EXECUTED 0
- Phase 232: PASS 16 / FAIL 0 / BLOCKED 0 / NOT EXECUTED 0
- Phase 233: PASS 16 / FAIL 0 / BLOCKED 1 / NOT EXECUTED 0
- Phase 234: PASS 30 / FAIL 0 / BLOCKED 1 / NOT EXECUTED 0
- `npx tsc --noEmit`: exit 0
- `git diff --check`: clean

## 12. Real provider limitations
235U BLOCKED :: AWS_REGION_NOT_CONFIGURED — real AWSTrafficRouter in an
environment without AWS configuration. Honest §REAL-WORLD EXECUTION RULE
classification, not counted as PASS.
