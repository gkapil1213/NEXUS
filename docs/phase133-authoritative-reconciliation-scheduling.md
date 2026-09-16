# Phase 133 — Authoritative CI Reconciliation Scheduling

Baseline: 3bafeef (nexus-phase132-complete) plus Phase 133 changes.

## Purpose

Phase 132 shipped CicdReconciliationService: a durable, idempotent service
that drains open CI reconciliation rows and drives them to REGISTERED or
BLOCKED. It is correct and fully tested — but no production code called it.
Phase 133 closes that last gap by running the reconciler on a bounded,
single-flight schedule inside the existing kernel lifecycle.

No new execution engine, worker pool, or job queue is introduced.

## Reachable path (post-133)

    createKernel()                                        [src/core/kernel.ts]
      -> builds CiPipelineEngine + Phase 132 reconcilers (unchanged)
      -> constructs CicdReconciliationScheduler(_phase132Reconciler)
      -> scheduler.start()  (fires first tick immediately)
      -> attaches to cicd.scheduler (optional; present only when SQLite store
         and the GitHub bridge are wired)
      -> stores on this.cicdScheduler for shutdown

    Scheduler loop                                        [src/core/cicd-reconciliation-scheduler.ts]
      setInterval(tick, delay)
        delay = 0 on first start
        delay = min(intervalMs * 2^consecutiveFailures, maxBackoffMs)
                + floor(random() * jitterMs)
      tick()
        - single-flight: if a tick is already in flight, coalesce
        - await drain.reconcileOpen()
          -> CicdReconciliationService.reconcileOpen()      (Phase 132)
             -> listOpen() over ci_artifact_reconciliations
             -> per row: reconcileOnce(run_id)
             -> updates state to REGISTERED or BLOCKED durably
        - success: consecutiveFailures = 0
        - failure: consecutiveFailures++ ; onError(...) best-effort

    Graceful shutdown                                     [src/core/kernel.ts shutdown()]
      -> stopCicdReconciliationScheduler()
         -> scheduler.stop()
            - clears the timer
            - awaits any in-flight tick
            - never throws
         - idempotent; safe to call twice

## Authority (unchanged from Phase 132)

- GitHub Actions remains authoritative for remote CI run state.
- nexus-image-digest.json remains authoritative for the remote CI image digest.
- The scheduler only drives the existing reconciler; it never fabricates
  state, never dispatches a workflow, never bypasses release enforcement.

## What Phase 133 does NOT do

- Does not call GitHub, the registry, or Docker from the scheduler. Those
  calls live in the Phase 132 reconciler, unchanged.
- Does not add a distributed lock. Single-process deployments are safe
  (single-flight per scheduler instance). Multi-process deployments will
  each run their own scheduler; the reconciler's SQLite UNIQUE constraints
  guarantee idempotency even under concurrent ticks.
- Does not add a persistence migration. The Phase 132 tables are sufficient;
  scheduling state lives in memory and is rebuilt on restart.

## Restart behavior

| Case | Behavior |
|------|----------|
| Process restarts mid-tick | In-memory scheduler state is lost; on next createKernel() start() fires immediately; listOpen() re-reads durable rows and resumes. |
| Process restarts after a failure | consecutiveFailures resets to 0; next tick uses intervalMs. No fabricated state. |
| Kernel.shutdown() called | scheduler.stop() clears the timer, awaits in-flight tick, returns; safe if called twice. |
| SQLite store not wired | Scheduler is not constructed; cicd.scheduler is undefined. No behavior change. |
| GitHub bridge not wired | Same — reconciler is not constructed; scheduler is not constructed. |

## Observability

The scheduler surfaces state via stats():
  running, inFlight, consecutiveFailures, lastTickStartedAt,
  lastTickDurationMs, lastError, startedAt

Errors from reconcileOpen() are forwarded to onError (best-effort) and
recorded in stats().lastError. The scheduler never logs or emits secrets —
its inputs are already redacted by the Phase 132 reconciler.

## Modules NOT touched by Phase 133

- CicdReconciliationService, CiArtifactReconciliationService, CiPipelineEngine
- ProductionReleaseEnforcement, ReleaseDeploymentBridge, DeploymentOrchestrator
- ExecutionEngine, DispatchService, JobDispatcher, RemoteExecutionManager
- ArtifactStore, artifact-signing
- Phase 132 migrations (150)