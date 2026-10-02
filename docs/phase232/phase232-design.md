# Phase 232 - Provider uncertainty reconciliation and lost-response safety

## Problem

When NEXUS invokes `ReleaseExecutionProvider.execute()`, the provider may
commit the mutation and then lose its response (transport failure, process
crash, timeout). The existing interface declared `reconcile?()` for exactly
this case, but no code path called it. The gap: an uncertain execute stayed
uncertain forever and risked a blind retry.

## Solution

One new method on the existing `ProductionReleaseEnforcementService`:

    async recoverForIntent(req: ReleaseExecutionRequest): Promise<ProviderReconciliationResult>

- delegates to `this.provider.reconcile(req)` if present
- returns `UNKNOWN` with a precise message when:
  - no provider is wired
  - the provider does not implement `reconcile()`
  - `reconcile()` throws
- never invokes `execute()`
- never fabricates a `deploymentId`

No new orchestrator, no new provider interface, no new persistence.

## Semantics

    reconcile() => DEPLOYED       reuse the discovered deploymentId; caller
                                  continues through existing verification.
                                  Never calls execute() again.
    reconcile() => NOT_DEPLOYED   caller may retry, still subject to every
                                  existing gate (authorization, lease,
                                  release readiness, artifact binding,
                                  source revision, security).
    reconcile() => UNKNOWN        caller stays RECOVERY_REQUIRED.
                                  No retry.
    no reconcile()                UNKNOWN. Never assume NOT_DEPLOYED.
    reconcile() throws            UNKNOWN. Never assume success or failure.

## Verified this phase

232A existing reconciliation contract callable
232B lost response after a REAL provider-side mutation (mutation committed
     before the throw)
232C recovery invokes reconcile()
232D DEPLOYED binds existing deploymentId
232E DEPLOYED does not re-execute (executeCalls stays 1)
232F NOT_DEPLOYED permits exactly one guarded retry (executeCalls=2)
232G UNKNOWN blocks retry (executeCalls stays 1)
232H missing reconcile() -> UNKNOWN, never NOT_DEPLOYED
232I DEPLOYED with null deploymentId surfaces null; caller must
     RECOVERY_REQUIRED
232J reconcile() throws -> UNKNOWN
232K no provider wired -> UNKNOWN
232L repeated reconciliation idempotent (3 reconciles, still 1 execute)
232M cross-release identity preserved (distinct deploymentIds per release)
232N durable identity observed by a fresh service instance
232O no fabricated ACTIVE / KNOWN_GOOD at the reconciliation boundary
232P kernel-exposed enforcement service has recoverForIntent

## Limits

- Real AWS reconcile is implemented in `AWSTrafficRouter.reconcile()` but
  requires AWS credentials/region. In this environment it returns
  `PROVIDER_UNAVAILABLE`, which is honest.
- The service is the reconciliation boundary; whether to retry is the
  caller's decision, made under the existing gates.