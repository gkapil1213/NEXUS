# Phase 226 — Durable Deployment Lifecycle, Health Gates, Rollback & Recovery

## Position

Phase 225 delivered real end-to-end deployment through the NEXUS canonical
path (see tag `nexus-phase225-complete`). Phase 226 verifies that the
durable lifecycle around that deployment path is complete, restart-safe,
concurrency-safe, and truthful.

## Discovery: nearly all state machinery already exists

Repository inspection at HEAD (post-Phase-225) shows:

| Concern                          | Component                                    |
|----------------------------------|----------------------------------------------|
| Durable deployment intent        | `ReleaseDeploymentIntentService`             |
| Durable deployment record        | `DeploymentHistoryService` / `DeploymentRecord` |
| Canonical deployment execution   | `CanonicalDeploymentOrchestrator`            |
| Rollback                         | `RollbackAgent` (`src/core/rollback.ts`)     |
| Recovery                         | `ReleaseRecoveryExecutor`                    |
| Environment lock                 | `deployment_locks` table (migration 066)     |
| Audit + events                   | `EventService`, `AuditService`               |
| Security gate                    | `ReleaseExecutionGate` (Phase 225)           |

No new architecture is required for Phase 226. The work is verification
plus one small enum extension.

## State machine mapping

Phase 226's example state names map 1:1 onto the repo's existing unions:

| Phase 226 §5 name      | `ReleaseIntentStatus`         | `DeploymentStatus`     |
|------------------------|-------------------------------|------------------------|
| DEPLOYMENT_REQUESTED   | `PENDING`                     | `PREPARING`            |
| PREPARING              | `DEPLOYMENT_INTENT_CREATED`   | `PREPARING`            |
| STARTING               | `DEPLOYING`                   | `DEPLOYING`            |
| HEALTH_CHECKING        | `HEALTH_CHECKING`             | `VERIFYING`            |
| HEALTHY                | `SMOKE_TESTING`               | `VERIFYING`            |
| ACTIVATED              | `KNOWN_GOOD`                  | `SUCCEEDED`            |
| MONITORING             | (implicit during `KNOWN_GOOD`) | —                     |
| FAILED                 | `FAILED` / `VERIFICATION_FAILED` | `FAILED`            |
| ROLLBACK_REQUESTED     | **not present**               | —                      |
| ROLLING_BACK           | `ROLLING_BACK`                | `ROLLING_BACK`         |
| ROLLED_BACK            | —                             | `ROLLED_BACK`          |
| CANCELLED              | `CANCELLED`                   | —                      |

`ROLLBACK_REQUESTED` is the only genuinely missing transition. Phase 226
documents the mapping rather than extending the enum, because:
- The existing `ROLLING_BACK` state is entered directly after a
  verification failure, and the transition is already audit-logged.
- Adding a new intermediate state would require modifying Phase 211 / 173
  recovery logic that has already been verified against the current union.

## Lifecycle as implemented

    getOrCreateAsync(intentInput)         → PENDING, created=true
    acquireLeaseAsync(key, workerId)      → lease granted
    transitionIfOwnedAsync(key, "AUTHORIZED", w, {}, ["PENDING"])
    transitionIfOwnedAsync(key, "DEPLOYING",  w, {}, ["AUTHORIZED"])
       ↓
    ReleaseExecutionGate.execute(...)     → enforcement.executeRelease
       ↓
    ReleaseDeploymentBridge               → CanonicalDeploymentOrchestrator.deploy
       ↓
    orchestrator sets DeploymentStatus:
       PREPARING → DEPLOYING → VERIFYING → SUCCEEDED
    intent service updates ReleaseIntentStatus:
       DEPLOYING → HEALTH_CHECKING → SMOKE_TESTING → KNOWN_GOOD
       ↓
    releaseLeaseAsync(key, w)

## Failure path

    orchestrator detect failure → DeploymentStatus = FAILED
    orchestrator invokes RollbackAgent.rollback(...)
       RollbackAgent:
         - getCurrent(project, env)               → current deployment
         - getPreviousKnownGood(project, env, current) → target
         - if no target → returns BLOCKED
         - docker inspect(target.image_id)        → verify image exists
         - docker run(target.image_id)            → restore container
         - SmokeTestService.run(target.url)       → verify health
         - history.markKnownGood / markFailed
    intent service: transitionIfOwnedAsync(key, "ROLLING_BACK", w, {}, ["FAILED"])
                    → transitionIfOwnedAsync(key, "KNOWN_GOOD" or "FAILED", ...)

## Concurrency

Single-worker-per-environment is enforced by:
- `ReleaseDeploymentIntentService.acquireLeaseAsync(key, workerId, ttl)` — CAS
- `transitionIfOwnedAsync(key, target, workerId, meta, allowedFrom)` — fenced
- `hasActiveIntentForEnvironmentAsync(env, excludeKey)` — read-side guard

A stale worker that no longer holds the lease cannot advance state (the
fence fails closed). `leaseTtlMs` bounds how long a crashed worker can
hold the environment.

## Crash recovery

`ReleaseRecoveryExecutor.runOnce()` walks `listRecoverableAsync()` and:

- `resumeFromIntent` — re-runs a `DEPLOYING` intent that never advanced
- `resumeVerification` — resumes a `HEALTH_CHECKING`/`SMOKE_TESTING` intent
- `markFailedAndRollback` — a terminal-failure intent gets rolled back
- `resumeRollback` — a `ROLLING_BACK` intent finishes the rollback
- `handleRecoveryRequired` — a `RECOVERY_REQUIRED` intent is
  re-verified or blocked with reason

No step fabricates success. A recovery that cannot safely determine state
leaves the intent in `RECOVERY_REQUIRED` with a durable reason.

## Security boundary

Every deployment path routes through `ReleaseExecutionGate.execute`,
which composes Phase 210 safety evaluation and the Phase 138
authorization. A release with `SECURITY_REVIEW != SUCCEEDED` is refused
before any intent is created (Phase 225 test 225W).

## Verification plan

`scripts/test-phase226-deployment-lifecycle.ts` exercises:

- 226A  intent service reachable from kernel
- 226B  getOrCreateAsync creates durable intent
- 226C  getOrCreateAsync idempotent (same key, created=false)
- 226D  acquireLeaseAsync grants to first worker
- 226E  acquireLeaseAsync denies second worker while first holds
- 226F  transitionIfOwnedAsync by lease holder succeeds
- 226G  transitionIfOwnedAsync by non-holder refuses (fenced CAS)
- 226H  transitionIfOwnedAsync with wrong allowedFrom refuses
- 226I  hasActiveIntentForEnvironmentAsync sees the intent
- 226J  releaseLeaseAsync lets another worker acquire
- 226K  KNOWN_GOOD is not recoverable (listRecoverableAsync excludes it)
- 226L  RECOVERY_REQUIRED is recoverable
- 226M  real deployment through ReleaseDeploymentExecutor → KNOWN_GOOD
- 226N  real rollback attempt with no prior KNOWN_GOOD → BLOCKED (via
        orchestrator auto-rollback on verification failure)
- 226O  audit/event rows persisted for the deployment
- 226P  Phase 225 regression

## Non-goals

- No new deployment tables — `release_deployment_intents`,
  `deployment_locks`, `execution_deployments` already cover §4 fields.
- No new rollback agent — `RollbackAgent` already implements §8-9.
- No new recovery engine — `ReleaseRecoveryExecutor` already implements §12.
- No new locking mechanism — lease + fenced CAS already implements §10.
- No new state enum names — the §5 mapping table above is the canonical one.

## Operational limitations

- The Node `HostBridge` (`scripts/host-bridge-node.ts`) is required for
  any process that runs the runtime binder outside the browser host.
  This is unchanged from Phase 225.
- `ROLLBACK_REQUESTED` is not a distinct persisted state; the transition
  from `FAILED` to `ROLLING_BACK` carries the same audit semantics.
