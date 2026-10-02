# Phase 233 - Post-cutover production verification before ACTIVE

## Gap

`DeploymentActivationService.activate()` transitioned
`TRAFFIC_CUTOVER -> POST_ACTIVATION_HEALTH_CHECK -> ACTIVE` with empty
patches `{}` and never called `this.router.health()`. So an ACTIVE intent
had no durable evidence that the newly routed target was actually serving.
`CanonicalDeploymentOrchestrator` verified the deployment BEFORE cutover
(KNOWN_GOOD), but no code verified the target AFTER cutover.

## Fix

src/core/deployment-activation-service.ts: after a successful cutover, call
the provider's real `health(cutoverTarget)` primitive:

  HEALTHY   -> transition to POST_ACTIVATION_HEALTH_CHECK with provider /
               providerStatus / providerDeploymentId / reconciledAt /
               reconciliationEvidence, then to ACTIVE with the same
               evidence binding.
  non-HEALTHY -> transition to ACTIVATION_FAILED with
               POST_CUTOVER_HEALTH_<verdict>:<reason>. Never ACTIVE.

For the AWS provider, `health(tgArn)` executes the real
`elbv2 describe-target-health` CLI call (implemented Phase 230). For the
NoopTrafficRouter it returns BLOCKED, which correctly prevents ACTIVE.

## Invariants preserved

- Activation still starts only from KNOWN_GOOD.
- Lease + fenced CAS still gate every transition.
- Cutover refusal still skips health (no phantom call).
- No new orchestrator, no new health framework, no schema change.
- All evidence lives in existing intent columns
  (provider, provider_status, provider_deployment_id, reconciled_at,
  reconciliation_evidence).

## Verified this phase

233A kernel wiring + spy router canHealthCheck
233B cutover + health both required (intent=ACTIVE only after both)
233C health PASS -> ACTIVE
233D health UNHEALTHY -> ACTIVATION_FAILED, reason=POST_CUTOVER_HEALTH_UNHEALTHY
233E health BLOCKED -> ACTIVATION_FAILED
233F health UNKNOWN -> ACTIVATION_FAILED
233G identity binding (provider, provider_status, provider_deployment_id,
     reconciled_at all persisted)
233H verification evidence written to reconciliation_evidence
233I evidence bound to the correct releaseId
233J foreign lease refuses activation
233K stale worker cannot reach ACTIVE
233L cutover refusal skips health (healthCalls=0)
233N Phase 232 recoverForIntent still works
233O Phase 231 lifecycle wiring intact
233P no secrets in evidence
233Q typecheck

## BLOCKED

233M real AWS provider health() -> BLOCKED (AWS_REGION_NOT_CONFIGURED).
Real `elbv2 describe-target-health` requires credentials + region.