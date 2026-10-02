// src/core/traffic-router-factory.ts
// Phase 229/230: provider discovery with honest AWS visibility.
//
// The factory returns AWSTrafficRouter whenever the AWS env config is
// present, EVEN when credentials/region are missing. The router itself
// then reports the real BLOCKED reason on each call. This preserves
// AWS diagnostics instead of hiding them behind the generic Noop reason.
// NoopTrafficRouter is returned only when no AWS configuration exists.

import { AWSTrafficRouter, readAwsTrafficRouterConfig } from "./aws-traffic-router";
import { NoopTrafficRouter, type TrafficRouter } from "./traffic-router";

export type TrafficRouterDiscoveryKind =
  | "aws-selected"
  | "aws-selected-blocked"
  | "noop-no-config";

export interface TrafficRouterDiscovery {
  router: TrafficRouter;
  kind: TrafficRouterDiscoveryKind;
  routerKind: TrafficRouter["kind"];
  reason: string | null;
  awsCapabilities: Awaited<ReturnType<AWSTrafficRouter["capabilities"]>> | null;
  probedAt: number;
}

export async function discoverTrafficRouter(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TrafficRouterDiscovery> {
  const cfg = readAwsTrafficRouterConfig(env);
  const awsConfigured = !!(cfg.region && (cfg.loadBalancerArn || cfg.targetGroupArn));

  if (!awsConfigured) {
    return {
      router: new NoopTrafficRouter(),
      kind: "noop-no-config",
      routerKind: "noop",
      reason: "NO_AWS_TRAFFIC_CONFIGURATION",
      awsCapabilities: null,
      probedAt: Date.now(),
    };
  }

  const aws = new AWSTrafficRouter(cfg);
  let cap: Awaited<ReturnType<AWSTrafficRouter["capabilities"]>> | null = null;
  try { cap = await aws.capabilities(); } catch { cap = null; }

  // Always return the AWS router when AWS config is present. The router
  // itself is honest BLOCKED when credentials/region are missing, and the
  // real reason travels with the discovery result.
  const enabled = !!cap && cap.canCutover && cap.canReconcile;
  return {
    router: aws,
    kind: enabled ? "aws-selected" : "aws-selected-blocked",
    routerKind: aws.kind,
    reason: enabled ? null : (cap?.reason ?? "AWS_TRAFFIC_ROUTER_BLOCKED"),
    awsCapabilities: cap,
    probedAt: Date.now(),
  };
}
