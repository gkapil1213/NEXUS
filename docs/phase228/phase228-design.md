# Phase 228 - Production Traffic Reconciliation and Recovery

## Recon at HEAD a50c043 (post-Phase 227)

| Concept | Status |
|---|---|
| Durable deployment intent | ReleaseDeploymentIntentService (unchanged) |
| Activation lifecycle | DeploymentActivationService (Phase 227) |
| TrafficRouter | NoopTrafficRouter only - no real provider |
| DeploymentRecord | Has previous_deployment_id + is_rollback fields |
| getPreviousKnownGood | DeploymentHistoryService method |
| Health adapters | SmokeTestService.checkHealth, HealthAgent, InfrastructureHealthService.checkHttp/checkLocalContainer |
| Real reverse proxy / LB / mesh | DOES NOT EXIST |

## Honest conclusion

Phase 228 has real, testable work that does NOT require traffic infrastructure:

1. Fix classifier semantics per section 17:
   - ACTIVE and MONITORING cannot be ALREADY_KNOWN_GOOD.
     They require traffic reconciliation against the real provider.
   - TRAFFIC_RESTORED cannot be RESUME_ROLLBACK.
     It requires post-rollback verification.
2. Capture the previous active target BEFORE cutover (persist via
   DeploymentHistoryService.previous_deployment_id).
3. Add POST_ROLLBACK_HEALTH_CHECK state.
4. Reconciliation detection logic testable with NoopTrafficRouter.

And honest BLOCKED at every traffic step:
- Real cutover: BLOCKED (NO_TRAFFIC_ROUTER_CONFIGURED)
- Post-activation health proving traffic is live: BLOCKED
- Real rollback of an activated deployment: BLOCKED

## State machine (additive)

ReleaseIntentStatus gains:
  POST_ROLLBACK_HEALTH_CHECK

## What gets fixed in release-recovery.ts

BEFORE (Phase 227, incorrect):
  ACTIVE | MONITORING -> ALREADY_KNOWN_GOOD
  TRAFFIC_RESTORED    -> RESUME_ROLLBACK

AFTER (Phase 228, honest):
  ACTIVE | MONITORING -> RECOVERY_REQUIRED (requiresDockerInspection=true)
    reason: "active state requires traffic reconciliation; NEXUS DB state
             alone does not prove the provider points at the intended target"
  TRAFFIC_RESTORED    -> RECOVERY_REQUIRED (requiresDockerInspection=true)
    reason: "traffic restore requires post-rollback health verification;
             RESUME_ROLLBACK is not correct because the rollback already
             completed"
  POST_ROLLBACK_HEALTH_CHECK -> RECOVERY_REQUIRED
    reason: "post-rollback health check was interrupted"

## What gets added to DeploymentActivationService

Before cutover:
  1. Resolve current active deployment via
     history.getCurrentDeployment(project_id, environment)
  2. Persist its id as previous_deployment_id on the new deployment record
  3. Include it in CutoverRequest.previousContainerName
  4. Only then invoke router.cutover()

When NoopTrafficRouter returns BLOCKED:
  - Set ACTIVATION_FAILED with reason NO_TRAFFIC_ROUTER_CONFIGURED
  - Do NOT set ACTIVE
  - Do NOT lose the captured previous target

## What real cutover would require

A real TrafficRouter implementation backed by:
- AWS ELB / GCP LB / Azure LB with credentials
- A reverse proxy the ProcessExecutor allowlist permits
- A Kubernetes Service/Ingress

None is configured. Every real cutover returns BLOCKED.