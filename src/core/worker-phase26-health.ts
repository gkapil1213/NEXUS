export type HealthState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'UNAVAILABLE';

export interface Phase26HealthInput {
  latency: number;
  availability: number;
  errorRate: number;
  throughput: number;
  resourceSaturation: number;
  dependencyHealth: number;
  deploymentState: string;
  infrastructureState: string;
  thresholds: { maxLatency: number; minAvailability: number; maxErrorRate: number; minThroughput: number; maxSaturation: number; minDependencyHealth: number };
}

export function evaluateHealth(input: Phase26HealthInput): HealthState {
  if (input.deploymentState === 'UNKNOWN' || input.infrastructureState === 'UNKNOWN') return 'UNKNOWN';
  if (input.availability === 0) return 'UNAVAILABLE';
  if (input.errorRate > input.thresholds.maxErrorRate || input.latency > input.thresholds.maxLatency || input.availability < input.thresholds.minAvailability) return 'UNHEALTHY';
  if (input.resourceSaturation > input.thresholds.maxSaturation || input.dependencyHealth < input.thresholds.minDependencyHealth || input.throughput < input.thresholds.minThroughput) return 'DEGRADED';
  return 'HEALTHY';
}
