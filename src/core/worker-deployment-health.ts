export type RuntimeHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'UNAVAILABLE';

export interface RuntimeHealthInput {
  httpStatus: number | null;
  processHealthy: boolean;
  deploymentState: string;
  errorRate: number;
  latency: number;
  availability: number;
  restartCount: number;
  readiness: boolean;
  liveness: boolean;
  resourcePressure: number;
}

export function evaluateRuntimeHealth(input: RuntimeHealthInput): RuntimeHealthStatus {
  if (input.httpStatus === null && !input.processHealthy) return 'UNAVAILABLE';
  if (!input.readiness) return 'UNHEALTHY';
  if (input.errorRate > 0.1 || input.latency > 1000 || input.availability < 0.9 || input.restartCount > 5) return 'UNHEALTHY';
  if (input.resourcePressure > 0.9 || input.deploymentState === 'FAILED') return 'DEGRADED';
  if (input.httpStatus && input.httpStatus >= 500) return 'UNHEALTHY';
  return 'HEALTHY';
}
