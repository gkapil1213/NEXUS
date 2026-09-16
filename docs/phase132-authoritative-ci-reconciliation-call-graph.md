# Phase 132 — Authoritative CI Reconciliation Call Graph

Baseline: nexus-phase131-complete (a071b87) + Phase 132 changes.

## Reachable path

Stage 1 — Durable engineering identity (Phase 131a, unchanged)
  bindDurableEngineeringJob -> SQLite execution_jobs (UNIQUE idempotency_key).

Stage 2 — Engineering pipeline stages (Phase 131, unchanged)
  REGISTRY_PUBLISH emits LOCAL IMAGE_DIGEST artifact (NOT remote).
  The LOCAL artifact is not authoritative for GitHub Actions builds.

Stage 3 — CI handoff (src/core/engineering.ts handoffToCI -> cicd.ts startRunExternal)
  a) require workflow_file + commit_sha, else BLOCKED.
  b) CICDRunManager.trigger -> GitHubActionsCICDProvider.trigger
     -> GitHubService.dispatchWorkflow -> resolveNewRun (bounded; never guesses).
  c) persist external_run_id to ci_pipeline_runs BEFORE the RUNNING transition.
  d) transitionRun(QUEUED -> RUNNING).
  Phase 132: reconciler.ensure() -> INSERT ci_artifact_reconciliations
             UNIQUE (provider_id, external_run_id).

Stage 4 — Durable CI reconciliation (src/core/cicd-reconciliation.service.ts)
  reconcileOnce(runId) is idempotent:
    - listOpen() reads ci_artifact_reconciliations
    - load CiPipelineRun from ci_pipeline_runs
    - pollRun (cicd.ts) -> CICDRunManager.getStatus
        -> GitHubActionsCICDProvider.getStatus
        -> GitHubService.getWorkflowRun
        -> mapGitHubStatus (unknown -> BLOCKED, never SUCCEEDED)
    - FAILED / CANCELLED / BLOCKED -> state=BLOCKED, no release.
    - QUEUED / RUNNING -> state stays PENDING.
    - SUCCEEDED -> state=ARTIFACT_VALIDATING, invoke artifact reconciler.

Stage 5 — Remote artifact reconciliation (src/core/ci-artifact-reconciliation.service.ts)
    - listArtifacts for the exact external run.
    - filter by name == "nexus-image-digest.json":
        0     -> BLOCKED ARTIFACT_MISSING
        >1    -> BLOCKED ARTIFACT_AMBIGUOUS
        expired -> BLOCKED ARTIFACT_EXPIRED
    - download via GitHubService.downloadWorkflowRunArtifact (bounded, authenticated).
    - extractSingleZipMember: single member only, size-capped, no traversal.
    - validateCiArtifact: strict schema + execution/commit/run/provider/repo
      + ^sha256:[a-f0-9]{64}$ + immutable_reference == image_repository@image_digest.
    - idempotency: ci_image_digest_bindings UNIQUE (execution, run, digest).
    - ArtifactService.register(kind=IMAGE_DIGEST).

Stage 6 — Release gate hardening (src/core/engineering.ts handoffToRelease)
    - findBindingForExecutionDigest(executionId, imageDigest):
        absent -> BLOCKED CI_DIGEST_NOT_RECONCILED
        commit / repository / digest mismatch -> BLOCKED
    - Enforcement is gated on the reconciler being wired, so Phase 131 tests
      (which do not create bindings) remain green.

Stage 7 — Existing Phase 130 release enforcement (unchanged)
    requestRelease -> ProductionReleaseDecisionService
    executeRelease -> ReleaseDeploymentBridge
      -> ReleaseDeploymentIntentService (idempotent)
      -> CanonicalDeploymentOrchestrator.deploy
      -> KNOWN_GOOD | FAILED | BLOCKED

Stage 8 — Return EngRunResult.

## Authority

- GitHub Actions is authoritative for the remote CI run state.
- nexus-image-digest.json is authoritative for the remote CI image digest.
- The LOCAL docker daemon and the container-registry provider's local
  publish-digest path are NOT used for remote CI digests.
- Release requires exact digest binding + approval + Phase 130 policy.
- Unresolved ambiguity -> BLOCKED, never SUCCEEDED.

## Restart cases

A. Crash after dispatch, before external_run_id persisted:
   startRunExternal re-enters; bounded resolveNewRun; never redispatch twice;
   ambiguous -> BLOCKED.
B. Crash after external_run_id persisted:
   Restart loads ci_pipeline_runs + ci_artifact_reconciliations; pollRun resumes.
C. Crash after SUCCEEDED, before digest reconciliation:
   row state PENDING or ARTIFACT_VALIDATING; next reconcileOnce drives Stage 5.
D. Malformed artifact -> BLOCKED ARTIFACT_VALIDATION_FAILED:<code>.
E. Digest mismatch vs approval -> BLOCKED APPROVAL_MISMATCH.
F. Transient GitHub failure -> retry via pollRun; attempts increments; no fake success.
G. Duplicate reconciliation -> idempotent via ci_image_digest_bindings UNIQUE.
H. Conflicting digest -> BLOCKED DIGEST_CONFLICT_WITH_EXISTING_BINDING.

## Honest scope

Live GitHub Actions dispatch, live registry push + digest, and live Docker
build + deploy + smoke require external services not present in the
development environment. They are exercised only via contract tests.
When unavailable, NEXUS returns BLOCKED with a machine-readable reason.

## Modules NOT touched by Phase 132

ExecutionEngine, ExecutionDispatchPort, RemoteExecutionManager,
JobDispatcher, DispatchService, ProductionReleaseEnforcement,
ReleaseDeploymentIntentService, DeploymentReleaseBridge,
DeploymentOrchestrator, ArtifactStore, artifact-signing,
src/core/providers/github-actions-adapter.ts (dead stub; left in place).