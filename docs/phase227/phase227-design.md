# Phase 227 — Production Activation, Traffic Cutover, Zero-Downtime Rollout

## Recon at HEAD 5756b71 (post-Phase 226)

| Concept | Status |
|---|---|
| Durable deployment intent | ReleaseDeploymentIntentService |
| Deployment record | DeploymentHistoryService + DeploymentRecord |
| Rollback agent | RollbackAgent |
| Recovery executor | ReleaseRecoveryExecutor |
| Docker ops | DockerAdapter (run/inspect/ps/logs/stop/rm/tag/push/build/info/version) |
| Port mapping | docker run -p host:container (real) |
| Environment locks | deployment_locks + intent lease |
| Traffic router | DOES NOT EXIST |
| Cutover primitive | DOES NOT EXIST |
| nginx/traefik/caddy/haproxy/envoy | not configured |
| aws-provider listLoadBalancers() | exists but not wired to release path; no credentials |

## Honest conclusion

Per prompt sections 7 and 27: if no real traffic provider exists, BLOCKED is correct.

Phase 227 therefore:
1. Implements the real activation lifecycle (states, transitions, leases, audit)
2. Implements the TrafficRouter interface
3. Ships NoopTrafficRouter returning BLOCKED / NO_TRAFFIC_ROUTER_CONFIGURED
4. Tests every lifecycle step that can execute
5. Reports cutover BLOCKED honestly
6. Reports post-activation verification NOT EXECUTED
7. Reports rollback-of-activated BLOCKED

No fake cutover. No fake ACTIVE. No parallel architecture.

## State machine (additive)

ReleaseIntentStatus gains (existing states unchanged):
  ACTIVATION_REQUESTED, ACTIVATING, TRAFFIC_CUTOVER,
  POST_ACTIVATION_HEALTH_CHECK, ACTIVE, MONITORING,
  ACTIVATION_FAILED, HEALTH_DEGRADED, ROLLBACK_REQUESTED, TRAFFIC_RESTORED

Lifecycle:
  KNOWN_GOOD -> ACTIVATION_REQUESTED -> ACTIVATING -> TRAFFIC_CUTOVER
  -> POST_ACTIVATION_HEALTH_CHECK -> ACTIVE -> MONITORING

Failure:
  ACTIVATING | TRAFFIC_CUTOVER | POST_ACTIVATION_HEALTH_CHECK -> ACTIVATION_FAILED
  ACTIVE -> HEALTH_DEGRADED -> ROLLBACK_REQUESTED -> ROLLING_BACK
  -> TRAFFIC_RESTORED -> ROLLED_BACK

All transitions use existing transitionIfOwnedAsync (fenced CAS) plus
acquireLeaseAsync (distributed lease). No new locking system.

## New components

- src/core/traffic-router.ts - TrafficRouter interface + NoopTrafficRouter
- src/core/deployment-activation-service.ts - activate() and rollback()
- src/core/kernel.ts - exposes deploymentActivationService