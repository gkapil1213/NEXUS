# Phase 252 — Durable Drift Observation Loop

## Objective

Close the Phase 251 gap where the production drift-recovery chain was fully
wired but had no live runtime driver. Phase 252 adds an opt-in periodic
supervisor that scans authoritative persisted deployments, runs the existing
DockerDeploymentObserver against each, and drives the Phase 250/251 production
chain (processDeploymentDriftDurable -> AsyncIncidentStore) when integrity is
not VERIFIED.

## Architecture

    DeploymentHistoryService (authoritative KNOWN_GOOD records)
              |
              v
    DockerDeploymentObserver.observe(deploymentId)
              |
              v
    evaluateDeploymentIntegrity(expected, observation)     [Phase 249]
              |
              v
    processDeploymentDriftDurable(...)                     [Phase 250/251]
              |
              v
    AsyncIncidentStore -> PostgreSQL security_incidents    [Phase 251]
              |
              v
    ReleaseRecoveryExecutor / supervisor                   [existing, unchanged]

## Boundaries

- The supervisor does NOT execute rollback, acquire leases, increment
  recovery_attempt, or call Docker directly.
- Recovery remains owned by ReleaseRecoveryExecutor and the release-recovery
  supervisor. This supervisor only produces drift observations and durable
  incidents.
- Scopes (projectId, environment) are caller-owned. Default is empty, which
  means ticks scan zero scopes and report zero. Nothing is fabricated.
- Opt-in: CONFIG.driftObserver.enabled gates both construction start and
  startDriftObserver(). boot() never starts the timer.

## Components

- src/core/drift-observation-supervisor.ts   (new)
- src/core/config.ts                          (added CONFIG.driftObserver)
- src/core/kernel.ts                          (added driftObserver field,
                                               boot() construction,
                                               startDriftObserver /
                                               stopDriftObserver /
                                               runDriftObservationNow /
                                               getDriftObserverStatus,
                                               shutdown hooks,
                                               BOOT_ORDER entry)
- scripts/test-phase252-drift-observation-loop.ts (new verifier)
- package.json                                (added test:phase252)

## Evidence

See artifacts/phase252/.

## Preserved Phase 249/250/251 behavior

- Phase 250 regression: unchanged (71/0/0/0)
- Phase 251 regression: unchanged (94/0/0/1 — the honest A19 NOT EXECUTED)
- Production recovery-context bridge: unchanged
- ReleaseRecoveryExecutor / ReleaseRecoveryService / RecoveryPolicyEngine:
  unchanged
- No second recovery engine, no second rollback executor, no second incident
  store
