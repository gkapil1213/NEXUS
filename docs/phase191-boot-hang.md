# Phase 191 — Kernel boot hang (open finding, narrowed location)

## Symptom

`NexusKernel.boot()` does not return when no Node host bridge is installed
on `globalThis.window.__NEXUS_HOST__`. Instrumented `step()` trace reaches
`recovery:running` and stops. Instrumented event trace stops before
`release.recovery.completed`.

## Eliminated (every one confirmed by isolation test)

- config, shared-PG bootstrap, `openEngine()` (sqlite), `EventService.init()`,
  `AuditService.probe()`, `LocalSecretProvider`, all dynamic imports under
  the orchestration block.
- Silent `docker pull` on uncached image — ruled out: runtime class is
  MANAGED_BROWSER_RUNTIME so docker ops return BLOCKED immediately.
- `maxIntentsPerRun` cap of 50 — confirmed working; the loop runs to
  completion.
- **The dispatch loop does NOT hang.** A `dispatch()` trace shows 50
  ENTER/RETURN pairs, `reportBlocked` incrementing 1→50, all returning.
- **The canonical binder await is NOT the hang.** Same trace: no
  `orchestrator.deploy()` was entered, because every intent is either
  RECOVERY_REQUIRED or DEPLOYMENT_INTENT_CREATED without a projectId,
  so `resumeFromIntent` short-circuits to `blockIntent` in every case.

## Where the hang is (narrowed, not confirmed)

Immediately after the dispatch loop returns, `runOnce()` runs:

    if (this.deps.reconciler) {
      const terminalStatuses = ["FAILED","VERIFICATION_FAILED","RECOVERY_REQUIRED","BLOCKED"];
      for (const status of terminalStatuses) {
        for (const intent of intents.listByStatus(status)) {
          const kind = intent.intentKind ?? "DEPLOY";
          if (kind !== "ROLLBACK") continue;
          ...
          await this.deps.reconciler.reconcile(intent.intentKey);
        }
      }
    }
    await svc.events.emit({ type: "release.recovery.completed", ... });

SQLite at last count held ~1598 terminal rows. Many are `rollback:*`
intents (ROLLBACK kind). The reconciler pass iterates them and awaits
`reconciler.reconcile()` per row. That is the only remaining long
loop. Confirmation requires an event trace on the reconciler pass.

## Does NOT block Phase 191

`CanonicalDeploymentOrchestrator` is constructible without the kernel.
`scripts/test-phase191-deployment-execution.ts` exercises the canonical
path against real Docker: 11/0/0.

## Recommended next step (dedicated session)

Instrument `ReleaseRecoveryEvidenceReconciler.reconcile()` and re-run
`kernel.boot()` against a fresh SQLite intent table. The location is
narrowed to that method. Do not interleave with Phase 191.
