export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface HealthGateInput {
  errorRate: number;
  latency: number;
  availability: number;
  crashRate: number;
  failedRequests: number;
  resourcePressure: number;
  securityFindings: number;
  incidentState: string;
  dependencyHealth: number;
  thresholds: { maxErrorRate: number; maxLatency: number; minAvailability: number; maxCrashRate: number; maxFailedRequests: number; maxResourcePressure: number; maxSecurityFindings: number; minDependencyHealth: number };
}

export function evaluateHealthGate(input: HealthGateInput): HealthStatus {
  if (input.incidentState === 'CRITICAL' || input.errorRate > input.thresholds.maxErrorRate || input.latency > input.thresholds.maxLatency || input.availability < input.thresholds.minAvailability) return 'UNHEALTHY';
  if (input.resourcePressure > input.thresholds.maxResourcePressure || input.securityFindings > input.thresholds.maxSecurityFindings || input.dependencyHealth < input.thresholds.minDependencyHealth) return 'DEGRADED';
  if (input.crashRate > input.thresholds.maxCrashRate || input.failedRequests > input.thresholds.maxFailedRequests) return 'DEGRADED';
  return 'HEALTHY';
}
