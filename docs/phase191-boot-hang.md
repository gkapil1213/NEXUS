# Phase 191 — Kernel boot hang (open finding, leading hypothesis)

## Symptom

`NexusKernel.boot()` does not return in the shared-persistence
environment when no Node host bridge is installed on
`globalThis.window.__NEXUS_HOST__`. Instrumented traces reach
`recovery:running` and stop. Event trace reaches ~30 x
`release.recovery.blocked` then stops before
`release.recovery.completed`.

## What was eliminated

Every subsystem boot reaches was exercised in isolation and passes
under 600ms: config, shared-PG bootstrap, openEngine() (sqlite),
EventService.init(), AuditService.probe(), LocalSecretProvider, and
all dynamic imports in the orchestration block.

## Where the recoverable set lives

`listRecoverable()` reads the **SQLite** store, not Postgres. At the
time of the trace, SQLite held 482 non-terminal intents:

    DEPLOYMENT_INTENT_CREATED  326
    RECOVERY_REQUIRED          126
    DEPLOYING                    1
    VERIFICATION_FAILED         29

`runOnce()` is bounded by `deps.maxIntentsPerRun ?? 50` and processes
at most 50 per cycle. Each `blockIntent` emits one
`release.recovery.blocked` event (release-recovery-executor.ts:589).
The trace stopped after roughly 30 such events.

## Leading hypothesis (not proven)

Within the 50-item window, at least one intent is
`DEPLOYMENT_INTENT_CREATED` with a valid `projectId` and complete
immutable fields. That routes through `resumeFromIntent`:

    intents.transitionIfOwned(..., "DEPLOYING", ...)
    const outcome = await this.deps.orchestrator.deploy(
      this.toDeploymentRequest(fresh, fresh.attemptId));

Inside `CanonicalDeploymentOrchestrator.deploy()`, the binder supplied
by kernel.ts (lines 517-539) runs:

    const bridge = getHostBridge();
    if (!bridge || typeof bridge.materializeWorkspace !== "function"
                || typeof bridge.cleanupWorkspace !== "function") {
      throw new Error("host bridge does not implement workspace ...");
    }
    await bridge.materializeWorkspace({ token, files: [...] });

In MANAGED_BROWSER_RUNTIME with no real host bridge, that await may
never settle — the stub returns a promise that does not resolve.

Consistent with every observation: no exception, no exit, no
docker call, no `release.recovery.completed`, hang reproduces
regardless of SQLite intent count once a DEPLOYMENT_INTENT_CREATED
intent with valid fields reaches the front of the 50-item window.

## Not root-caused

The hypothesis needs one clean probe: install an instrumented
`getHostBridge` and confirm whether `materializeWorkspace` resolves
in the MANAGED_BROWSER_RUNTIME case. That probe has not been run.

## Workaround (not a fix)

Terminalize SQLite non-terminal intents before boot. With an empty
recoverable set, `runOnce()` returns in a single cycle. This is a
test-environment cleanup, not a code change.

## Does NOT block Phase 191

`CanonicalDeploymentOrchestrator` is constructible without the kernel
and exercises the canonical path against real Docker:
`scripts/test-phase191-deployment-execution.ts` passes 11/0/0.

## Recommended next step

A dedicated debugging session:
  1. Fresh SQLite intent table (no stale rows).
  2. Install a logging `getHostBridge` stub.
  3. Single `NexusKernel.boot()` call with an event trace on
     `materializeWorkspace` and its resolution.
  4. If it hangs, the fix is a per-binder timeout in
     `CanonicalDeploymentOrchestrator.deploy()`; if it does not, the
     hang is elsewhere and the hypothesis is wrong.
