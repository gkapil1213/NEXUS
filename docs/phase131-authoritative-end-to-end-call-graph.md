# Phase 131 - Authoritative End-to-End Call Graph

## Purpose

Phase 131 establishes the authoritative production execution path from the
Engineering Workspace UI through durable execution, CI/CD, release
authorization, and deployment. This document records the ACTUAL call graph
that exists in the repository at commit `b3caa55` after 131a/131b/131c.

It replaces hypothetical/planned paths with what the code actually does.

## Authoritative user path (post-131)

    EngineeringWorkspace.tsx onExecute()
      -> executePlan(svc, actor, plan)                     [src/core/engineering.ts:1328]

      Stage 1 - Durable identity binding (131a)
        -> svc.orchestrator.submit(...)                    (existing NexusOrchestrator)
        -> bindDurableEngineeringJob(svc.executionStore, execution.id, {...})
           -> store.createJob({ jobType: "engineering", idempotencyKey: "engineering:<id>" })
           -> idempotent by key; returns existing job id on repeat

      Stage 2 - Engineering stages
        -> new PipelineEngine(psvc).ensureRun(...)
        -> engine.runStage(...) for each plan.stages entry
           DETECTING / BUILDING / TESTING / SECURITY_REVIEW
           DOCKERFILE_DETECTION / DOCKERFILE_VALIDATION / DOCKER_BUILD
           IMAGE_INSPECTION / IMAGE_SECURITY_SCAN / REGISTRY_PUBLISH
           SBOM_GENERATION / ARTIFACT_REGISTRATION
        -> REGISTRY_PUBLISH emits an IMAGE_DIGEST artifact containing
           { digest, repository, tag, image, immutable_reference }

      Stage 3 - CI handoff (131b)
        -> handoffToCI(svc.cicd, ctx, plan, verdict)       [engineering.ts:1168]
           - no cicd engine -> BLOCKED "no CI/CD engine wired"
           - no plan.repository/ref -> BLOCKED "no repository/ref configured"
           - else: cicd.engine.submitRun(ctx, "github", repository, ref)
                   cicd.engine.startRun(run, ctx, cicd.github)
                   - startRun internally checks svc.cicd (CICD bridge)
                     - bridge present + provider=="github" -> startRunExternal
                       -> persist external_run_id BEFORE RUNNING transition
                     - no bridge -> legacy RUNNING transition (no fake dispatch)

      Stage 4 - Release + deploy handoff (131c)
        -> handoffToRelease(svc, plan, executionId, ciStatus, verdict)  [engineering.ts:1219]
           - verdict != PASSED or no deploy signal -> null (no-op)
           - ciStatus != "SUCCEEDED" -> BLOCKED "CI_NOT_SUCCESSFUL"
           - no plan.environment -> BLOCKED "NO_ENVIRONMENT"
           - no plan.commitSha -> BLOCKED "NO_COMMIT_SHA"
           - no plan.approval or status != APPROVED -> BLOCKED "APPROVAL_REQUIRED"
           - svc.artifacts.list(executionId) -> find kind=="IMAGE_DIGEST"
             - absent -> BLOCKED "NO_REGISTRY_DIGEST"
             - parse __content for { digest, repository, tag }
           - approval must reference exact artifactId + artifactDigest + environment
             - mismatch -> BLOCKED "APPROVAL_MISMATCH"
           - svc.releaseEnforcement.requestRelease({...})
             -> ProductionReleaseDecisionService.decide (security gate + approval + digest)
             - not AUTHORIZED -> BLOCKED "RELEASE_NOT_AUTHORIZED"
           - svc.releaseEnforcement.executeRelease(authId, releaseId, artifactId, commitSha, env)
             -> ReleaseDeploymentBridge.execute()
                - artifact binding check (artifacts.list; match id)
                - registry image digest override from IMAGE_DIGEST artifact (Phase 107)
                - :latest rejection
                - ReleaseDeploymentIntentService.getOrCreate (idempotent intent key)
                - hasActiveIntentForEnvironment concurrency check (Phase 130)
                - acquireLease(intentKey, workerId)
                - transition(intentKey, "DEPLOYING")
                - CanonicalDeploymentOrchestrator.deploy(...)
                   -> RuntimeBridge -> token-bound DockerAdapter
                   -> docker stop / rm / run
                   -> docker inspect (immutable image id)
                   -> host port resolution
                   -> SmokeTestService.run (health + Playwright smoke)
                   -> KNOWN_GOOD only when identity+health+smoke+quality all PASS
                   -> on failure: RollbackAgent
                - transition(intentKey, KNOWN_GOOD|FAILED|BLOCKED)
                - releaseLease(intentKey, workerId)
           - map outcome: DEPLOYED -> PASSED, BLOCKED -> BLOCKED, FAIL -> FAILED

      Stage 5 - Return
        -> EngRunResult {
             execution, agentSummary, runId, stages, verdict,
             passed, failed, blocked, recovery, artifacts,
             durableJobId,           (131a)
             ci,                     (131b)
             deployment,             (131c)
           }

## Module disposition

| Module | Reachable from UI? | Role |
|---|---|---|
| engineering.ts | Yes (via executePlan) | Authoritative integration point |
| cicd.ts (CiPipelineEngine) | Yes (via handoffToCI) | CI dispatch, external_run_id persistence |
| github-actions-cicd-provider.ts | Yes (via CiPipelineEngine) | Real provider when GitHub connected |
| github.ts | Yes (via CiPipelineEngine) | GitHub API wrapper |
| container-registry-provider.ts | Yes (via REGISTRY_PUBLISH stage) | Real registry push + digest resolution |
| deployment-release-bridge.ts | Yes (via releaseEnforcement) | Durable intent + lease + artifact binding |
| release-deployment-intent.ts | Yes (via bridge) | Durable intent (release_deployment_intents) |
| production-release-enforcement.ts | Yes (via handoffToRelease) | Authorization + execution boundary |
| production-release-decision.ts | Yes (via enforcement) | Security gate + approval + digest match |
| deployment-orchestrator.ts | Yes (via bridge) | Real Docker deployment + verification |
| worker-autonomous-cicd-orchestrator.ts | No (unused from UI) | Parallel Phase 129 CI/CD orchestrator - NOT part of the authoritative UI path |
| worker-pipeline-execution.ts | No (projection only) | Domain projection for the pipeline execution |
| DeploymentManager | No (only test scripts) | Not production-authoritative; left as-is |
| worker-deployment-lock.ts | No (Phase 25 orchestrator only) | In-memory, not promoted |

## BLOCKED / FAILED semantics

Every handoff returns BLOCKED when a required capability is unavailable, with
a machine-readable `blockedReason`. BLOCKED never converts to SUCCEEDED.

Codes emitted by the handoffs:

    131b (CI):        NO_RELEASE_ENFORCEMENT is not emitted here; instead
                      "no CI/CD engine wired in this runtime"
                      "no repository/ref configured on plan"
    131c (release):   NO_RELEASE_ENFORCEMENT
                      CI_NOT_SUCCESSFUL
                      NO_ENVIRONMENT
                      NO_COMMIT_SHA
                      APPROVAL_REQUIRED
                      NO_REGISTRY_DIGEST
                      APPROVAL_MISMATCH
                      RELEASE_NOT_AUTHORIZED

## Real execution vs. unavailable capability (honest scope)

| Capability | When available | When unavailable |
|---|---|---|
| Command runtime (build/test) | Real exec via HostBridge | BLOCKED "no host executor" |
| Docker daemon | Real build/inspect/scan/push | BLOCKED "docker unavailable" |
| Container registry | Real push + digest | BLOCKED "registry unreachable" |
| GitHub Actions | Real workflow dispatch via CICD bridge | BLOCKED when bridge absent |
| Release enforcement | Full requestRelease + executeRelease | BLOCKED "not authorized" |
| Real Docker deploy | Runs via CanonicalDeploymentOrchestrator | BLOCKED with reason |

## Test evidence

`scripts/test-phase131-end-to-end-integration.ts` - 37 assertions.

- 131a (T01-T03): durable job creation, idempotency, distinct executions
- 131b (T04-T07): CI absent -> BLOCKED, no repo/ref -> BLOCKED, dispatched ->
  RUNNING preserved, no deploy signal -> ci null
- 131c (T08-T11): CI not SUCCEEDED -> BLOCKED, no IMAGE_DIGEST -> BLOCKED,
  approval mismatch -> BLOCKED, happy path -> DEPLOYED

Regression suites (all green at commit b3caa55):

    npx tsc --noEmit                          exit 0
    npx tsx scripts/test-phase127-...         111/111
    npx tsx scripts/test-phase128-...         35/35
    npx tsx scripts/test-phase129-...         50/50
    npx tsx scripts/test-phase130-...         23/23
    npx tsx scripts/test-phase131-...         37/37
    npm run build                             100 modules, no errors

### Coverage honesty

Tests exercise the HANDOFF DECISIONS - do they call CI, do they call
requestRelease/executeRelease, do they map outcomes honestly. They do NOT
exercise a real GitHub dispatch or a real Docker deploy. T06/T11 stub the CI
engine and enforcement service at their boundaries, per Phase 131 spec
section 20 ("mocks may be used only where an external dependency genuinely
cannot be invoked").

This means:

    PASSED       - handoff logic, idempotency, BLOCKED semantics,
                   durable identity binding, and all regression suites
    NOT EXECUTED - real GitHub Actions dispatch, real Docker build,
                   real container run + health + smoke verification

Real dispatch/verification requires an actual GitHub connection and a Docker
daemon; neither is available in the environment these tests ran in.

## What Phase 131 did NOT do

- Did not modify worker-autonomous-cicd-orchestrator.ts (unused from UI; left as Phase 130 asset)
- Did not promote worker-deployment-lock.ts
- Did not touch DeploymentManager
- Did not add a migration (all tables already existed)
- Did not create a parallel CI/CD, release, or deploy system