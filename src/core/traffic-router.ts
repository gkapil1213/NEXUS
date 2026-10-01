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
}