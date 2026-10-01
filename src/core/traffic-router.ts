// src/core/traffic-router.ts
// Phase 227: provider-aware traffic activation boundary.
//
// The TrafficRouter is the ONLY seam that may redirect production traffic.
// It must NOT be satisfied by changing a database status field.
//
// Repository inspection at HEAD (post-Phase 226) confirmed no reverse proxy,
// load balancer, service mesh, or container-network router exists in the
// NEXUS environment. The DockerAdapter exposes run/inspect/ps/logs/stop/rm/
// tag/push/build/info/version -- no network operations.
//
// Therefore:
//   - the interface is defined here for providers to implement,
//   - NoopTrafficRouter is the honest default and returns BLOCKED with
//     reason NO_TRAFFIC_ROUTER_CONFIGURED for every operation,
//   - every real cutover attempt in this environment returns BLOCKED.
//
// Never fake a cutover.

export type TrafficRouterKind =
  | "noop"
  | "reverse-proxy"
  | "load-balancer"
  | "service-mesh"
  | "container-endpoint";

export interface CutoverRequest {
  environment: string;
  intentKey: string;
  releaseId: string;
  commitSha: string;
  imageRepository: string;
  imageTag: string;
  imageId: string | null;
  imageDigest: string | null;
  containerName: string;
  containerPort: number;
  previousContainerName: string | null;
}

export interface CutoverResult {
  ok: boolean;
  reason: string | null;
  activeTarget: string | null;
}

export interface ActiveTarget {
  environment: string;
  targetName: string;
  containerId: string | null;
  imageId: string | null;
  imageDigest: string | null;
}

export interface TrafficRouter {
  readonly kind: TrafficRouterKind;
  /** Redirect production traffic to the verified candidate. */
  cutover(req: CutoverRequest): Promise<CutoverResult>;
  /** Redirect production traffic back to the previous verified target. */
  revert(req: CutoverRequest): Promise<CutoverResult>;
  /** Resolve the currently active target for an environment, if any. */
  resolveActive(environment: string): Promise<ActiveTarget | null>;

  /* Phase 229 additions. */
  resolveTarget(
    environment: string,
    identity: { releaseId: string | null; imageDigest: string | null },
  ): Promise<RouterTargetBinding | null>;
  validateTarget(target: RouterTargetBinding): Promise<{ valid: boolean; reason: string | null }>;
  health(targetId: string): Promise<RouterHealthResult>;
  reconcile(desired: RouterTargetBinding | null): Promise<RouterReconcileResult>;
  capabilities(): Promise<RouterCapabilityReport>;
}

/* Phase 229: provider-neutral target binding + health + reconciliation model. */

export interface RouterTargetBinding {
  environment: string;
  provider: TrafficRouterKind;
  providerTargetId: string;
  endpoint: string | null;
  releaseId: string | null;
  deploymentId: string | null;
  commitSha: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  imageId: string | null;
  imageDigest: string | null;
  containerId: string | null;
  containerName: string | null;
  containerPort: number | null;
  observedAt: number;
}

export type RouterHealthVerdict = "HEALTHY" | "UNHEALTHY" | "UNKNOWN" | "BLOCKED";

export interface RouterHealthResult {
  verdict: RouterHealthVerdict;
  targetId: string | null;
  reason: string | null;
  probedAt: number;
}

export type RouterReconcileVerdict =
  | "IN_SYNC"
  | "DRIFT"
  | "TARGET_MISSING"
  | "PROVIDER_UNAVAILABLE"
  | "AUTHENTICATION_BLOCKED"
  | "HEALTH_DEGRADED"
  | "UNKNOWN";

export interface RouterReconcileResult {
  verdict: RouterReconcileVerdict;
  reason: string | null;
  desiredTargetId: string | null;
  observedTargetId: string | null;
  reconciledAt: number;
}

export interface RouterCapabilityReport {
  kind: TrafficRouterKind;
  canResolveActive: boolean;
  canResolveTarget: boolean;
  canValidateTarget: boolean;
  canCutover: boolean;
  canRevert: boolean;
  canHealthCheck: boolean;
  canReconcile: boolean;
  reason: string | null;
  probedAt: number;
}

export const NO_TRAFFIC_ROUTER_REASON = "NO_TRAFFIC_ROUTER_CONFIGURED";

export class NoopTrafficRouter implements TrafficRouter {
  readonly kind: TrafficRouterKind = "noop";

  async cutover(_req: CutoverRequest): Promise<CutoverResult> {
    return { ok: false, reason: NO_TRAFFIC_ROUTER_REASON, activeTarget: null };
  }

  async revert(_req: CutoverRequest): Promise<CutoverResult> {
    return { ok: false, reason: NO_TRAFFIC_ROUTER_REASON, activeTarget: null };
  }

  async resolveActive(_environment: string): Promise<ActiveTarget | null> {
    return null;
  }

  async resolveTarget(
    _environment: string,
    _identity: { releaseId: string | null; imageDigest: string | null },
  ): Promise<RouterTargetBinding | null> {
    return null;
  }

  async validateTarget(_target: RouterTargetBinding): Promise<{ valid: boolean; reason: string | null }> {
    return { valid: false, reason: NO_TRAFFIC_ROUTER_REASON };
  }

  async health(_targetId: string): Promise<RouterHealthResult> {
    return { verdict: "BLOCKED", targetId: null, reason: NO_TRAFFIC_ROUTER_REASON, probedAt: Date.now() };
  }

  async reconcile(_desired: RouterTargetBinding | null): Promise<RouterReconcileResult> {
    return {
      verdict: "PROVIDER_UNAVAILABLE",
      reason: NO_TRAFFIC_ROUTER_REASON,
      desiredTargetId: null,
      observedTargetId: null,
      reconciledAt: Date.now(),
    };
  }

  async capabilities(): Promise<RouterCapabilityReport> {
    return {
      kind: "noop",
      canResolveActive: false,
      canResolveTarget: false,
      canValidateTarget: false,
      canCutover: false,
      canRevert: false,
      canHealthCheck: false,
      canReconcile: false,
      reason: NO_TRAFFIC_ROUTER_REASON,
      probedAt: Date.now(),
    };
  }
}
