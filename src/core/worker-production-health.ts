export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'UNAVAILABLE';

export interface HealthInput {
  availability: number;
  errorRate: number;
  latency: number;
  saturation: number;
  dependencyHealth: number;
  restartRate: number;
  deploymentFailures: number;
  sloStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
}

export function evaluateHealth(input: HealthInput): HealthStatus {
  if (input.sloStatus === 'UNKNOWN') return 'UNKNOWN';
  if (input.availability === 0) return 'UNAVAILABLE';
  if (input.sloStatus === 'UNHEALTHY' || input.availability < 0.9 || input.errorRate > 0.05 || input.deploymentFailures > 3) return 'UNHEALTHY';
  if (input.sloStatus === 'DEGRADED' || input.latency > 300 || input.saturation > 0.8 || input.dependencyHealth < 0.8) return 'DEGRADED';
  return 'HEALTHY';
}
