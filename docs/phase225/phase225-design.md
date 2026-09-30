# Phase 225 — Real Release + Deployment Execution

## Scope
Drive the existing dormant release-execution chain end-to-end from
RELEASE_READY. Do not build a parallel orchestration.

## Existing chain (do not replace)
ReleaseExecutionGate.execute(input)
  → evaluateReleaseSafety          [Phase 210, pure]
  → intents.getOrCreateAsync       [Phase 103 durable]
  → intents.acquireLeaseAsync      [distributed lease]
  → intents.transitionIfOwnedAsync(DEPLOYING)  [fenced]
  → enforcement.executeRelease     [Phase 138-178]
       → authorizeExecution
       → provider.execute          [ReleaseExecutionProvider]
            → ReleaseDeploymentBridge
                 → CanonicalDeploymentOrchestrator.deploy
                      → docker deploy → docker inspect → health → smoke
                      → KNOWN_GOOD / BLOCKED / FAILED
  → intents.transitionIfOwnedAsync(terminal)   [fenced]

## What Phase 225 adds
1. kernel.ts: store `releaseExecutionGate` as an instance field and expose
   `getReleaseExecutionGate()` so external callers (tests, HTTP surface)
   can invoke it.
2. src/core/release-deployment-executor.ts: thin adapter that takes
   EngineeringReleaseReadyOutcome + verificationRun + policy + intentInput
   + authorizationId + attemptId and calls gate.execute(). No new logic.
3. scripts/test-phase225-release-deployment.ts: 36-case conformance suite.
4. artifacts/phase225/*: evidence.
5. No new migration unless the executor needs a column that
   production_execution_authorizations or release_attestations lack.

## Provider semantics
- Docker daemon present → real deployment executes (same daemon as PG).
- No provider configured → DEPLOYMENT_PROVIDER_NOT_CONFIGURED → BLOCKED.
- Real docker failure → FAILED.
- Real verified success → SUCCEEDED.
- No fabricated URLs, IDs, container IDs, or health checks.

## Invariants preserved
- RELEASE_READY is mandatory predecessor.
- Artifact checksum verified (bridge).
- Source revision verified (orchestrator + safety gate).
- Terminal states not overwritable (release-deployment-intent CAS).
- Secrets redacted (auditDecision + event payload).

## Acceptance
All 22 items in §29 of the phase prompt.
