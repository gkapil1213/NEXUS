# Phase 231 - Production release-to-activation lifecycle integration and recovery proof

## Approach

No new orchestrator. The suite composes the existing authoritative chain:

  ProductionReleaseEnforcementService.requestRelease  (authorization)
    -> ReleaseExecutionGate.execute                    (gate + intent)
    -> ReleaseDeploymentExecutor.execute               (deployment)
    -> DeploymentActivationService.activate            (cutover + reconcile)
    -> DeploymentActivationService.rollback            (revert)

Provider-unavailable remains BLOCKED (NO_TRAFFIC_ROUTER_CONFIGURED).
Never fabricates ACTIVE. No competing top-level orchestrator was added.

## Verified this phase

231A kernel wiring exposes executor + activation + gate + intents
231B RELEASE_READY must be SUCCEEDED
231C missing source revision blocked
231D missing artifact blocked
231E SECURITY_REVIEW must be SUCCEEDED
231F no gate -> refused
231G activation requires KNOWN_GOOD
231H provider unavailable -> BLOCKED
231I no fake ACTIVE; intent lands in ACTIVATION_FAILED
231J lease fencing: non-holder refused
231K rollback refuses non-ACTIVE
231L previous target captured before cutover
231M reconcile honest without provider (PROVIDER_UNAVAILABLE)
231N restart recovery classification (TRAFFIC_CUTOVER -> RECOVERY_REQUIRED)
231O cross-environment isolation
231P secrets absent from persisted intents
231Q real deployment through NEXUS -> KNOWN_GOOD

## BLOCKED

231R real AWS provider: AWS_REGION_NOT_CONFIGURED

## What is NOT proven

Real AWS production cutover and rollback require live AWS credentials,
region, ALB, listener/rule, and target group. None is configured in this
environment. The provider path is implemented (Phase 229/230) and honestly
returns BLOCKED at runtime.