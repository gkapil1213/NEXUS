# Phase 130 - Authoritative Call Graph (Audit)

## Purpose

Phase 130 establishes one authoritative, durable production path from Phase 129
durable pipeline execution to real deployment, with honest BLOCKED/FAILED
semantics when capabilities are unavailable.

This document records the ACTUAL call graph discovered by inspecting the
repository at the Phase 129 baseline (commit 1e16b03, tag
`nexus-phase129-complete`). It is the §1 audit required before any code change.

## Existing authoritative deployment path (kernel-wired)

    ProductionReleaseEnforcementService
      -> requestRelease()  (eligibility: security gate + approval + digest match)
      -> executeRelease()  (dispatch through the bridge)
        -> ReleaseDeploymentBridge.execute()
           - artifact binding check (list artifacts for execution; match id)
           - registry image digest authority (IMAGE_DIGEST artifact override)
           - :latest rejection
           - ReleaseDeploymentIntentService.getOrCreate()   [idempotent by deterministic key]
           - acquireLease(intentKey, workerId)              [durable intent lease]
           - transition(intentKey, "DEPLOYING")
           - CanonicalDeploymentOrchestrator.deploy()
              - RuntimeBridge -> token-bound DockerAdapter + SmokeTestService
              - docker stop / rm / run
              - docker inspect (immutable image identity)
              - host port resolution
              - health check
              - Playwright smoke
              - KNOWN_GOOD only if identity + health + smoke + quality all PASS
              - on failure: RollbackAgent
           - transition intent -> KNOWN_GOOD | FAILED | BLOCKED
           - releaseLease(intentKey, workerId)

All state is durable in `release_deployment_intents` (migrations 146 + 148)
backed by the same SQLite ExecutionStore used by Phase 127-129.

## Where Phase 129 stops

`orchestrateCICD` in `src/core/worker-autonomous-cicd-orchestrator.ts`
transitions the release candidate to `PROMOTED` and returns. Its imports do not
include any release/deployment/intent/bridge module. The canonical deployment
path is NOT reachable from Phase 129 today.

**This is the concrete Phase 130 gap: a single integration point.**

## Module dispositions (Phase 130 §2, §9)

| Module | Reachable from Phase 129? | Disposition |
|---|---|---|
| `CanonicalDeploymentOrchestrator` | No (kernel only, called by bridge) | Preserve as deployment authority (§10) |
| `ReleaseDeploymentBridge` | No (kernel only) | Reuse (§3, §10) |
| `ReleaseDeploymentIntentService` | No (kernel only) | Reuse (§3) |
| `ProductionReleaseEnforcementService` | No (kernel only) | Integration entry point (§4) |
| `ReleaseRecoverySupervisor` / `ReleaseRecoveryExecutor` / `ReleaseRecoveryEvidenceReconciler` | No | Reuse when recovery is needed (§13) |
| `ApprovalGate` | No (store-backed, kernel-available) | Reuse (§7) |
| `DeploymentManager` | No (test scripts only) | Leave dead; do not promote |
| `worker-deployment-lock.ts` | No (Phase 25 orchestrator + test only) | Leave dead; rely on durable intent lease instead |
| `worker-autonomous-deployment-orchestrator.ts` | No | Not production-authoritative; leave |
| `ApprovalService` (in-memory) | No | Not the production approval authority; `ApprovalGate` is |

No second deployment path, no second intent table, no second lock system is
introduced. There is exactly one canonical path and Phase 130 does not modify
its internals.

## Phase 130 integration shape

    Phase 129 orchestrateCICD
      ... pipeline, stages, artifact, release candidate
      -> rc = PROMOTED
      -> optional: request.releaseEnforcement.executeRelease(...)
         -> existing ProductionReleaseEnforcementService
         -> existing ReleaseDeploymentBridge
         -> existing CanonicalDeploymentOrchestrator
         -> real Docker + real verification
      -> map outcome to orchestrator status:
           DEPLOYED -> COMPLETED
           FAIL     -> FAILED
           BLOCKED  -> BLOCKED (with machine-readable reason)

Absent `request.releaseEnforcement`: Phase 129 returns COMPLETED with
`deployed: false` - honest, because Phase 129's job ends at PROMOTED.

## Real execution vs unavailable capability

| Capability | Behavior when available | Behavior when unavailable |
|---|---|---|
| Docker runtime | Real container deploy | `BLOCKED`, reason from orchestrator |
| Smoke test service | Real Playwright + health | `BLOCKED`, `verification BLOCKED` |
| Registry image digest artifact | Authoritative digest override | Falls through to declared digest; mismatch -> `BLOCKED` |
| Human approval (production) | Requires durable approval record | `BLOCKED / APPROVAL_REQUIRED` |
| Release intent lease | Durable single-writer | Lease contention -> `BLOCKED`, not FAILED |

Never converted: `BLOCKED` -> `SUCCEEDED`; `FAIL` -> `SUCCEEDED`.

## Known limitations carried forward

1. `worker-deployment-lock.ts` is in-memory but not production-reachable.
   Documented; not promoted. Production concurrency uses the durable intent
   lease.
2. `ReleaseDeploymentBridge.executeWithIntent` does not currently check for
   other active intents in the same environment. Phase 130 adds a small
   pre-DEPLOYING concurrency check using the existing intent list API.

## Test commands

    npx tsc --noEmit
    npx tsx scripts/test-phase127-execution-state-machine.ts
    npx tsx scripts/test-phase128-execution-completion.ts
    npx tsx scripts/test-phase129-execution-integration.ts
    npx tsx scripts/test-phase130-release-deployment.ts