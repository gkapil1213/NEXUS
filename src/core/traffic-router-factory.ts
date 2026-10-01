// src/core/traffic-router-factory.ts
// Phase 229: provider discovery + honest default.
//
// Probes the AWS provider capabilities; returns AWSTrafficRouter when the
// full real configuration is present and reachable. Otherwise returns
// NoopTrafficRouter (BLOCKED for every traffic operation).

import { AWSTrafficRouter, readAwsTrafficRouterConfig } from "./aws-traffic-router";
import { NoopTrafficRouter, type TrafficRouter } from "./traffic-router";

export interface TrafficRouterDiscovery {
  router: TrafficRouter;
  kind: TrafficRouter["kind"];
  reason: string | null;
  awsCapabilities: Awaited<ReturnType<AWSTrafficRouter["capabilities"]>> | null;
  probedAt: number;
}

export async function discoverTrafficRouter(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TrafficRouterDiscovery> {
  const cfg = readAwsTrafficRouterConfig(env);
  const aws = new AWSTrafficRouter(cfg);
  let awsCap: Awaited<ReturnType<AWSTrafficRouter["capabilities"]>> | null = null;
  try {
    awsCap = await aws.capabilities();
  } catch {
    awsCap = null;
  }
  if (awsCap && awsCap.canCutover && awsCap.canReconcile) {
    return {
      router: aws,
      kind: aws.kind,
      reason: null,
      awsCapabilities: awsCap,
      probedAt: Date.now(),
    };
  }
  return {
    router: new NoopTrafficRouter(),
    kind: "noop",
    reason: awsCap?.reason ?? "AWS_TRAFFIC_ROUTER_NOT_CONFIGURED",
    awsCapabilities: awsCap,
    probedAt: Date.now(),
  };
}
