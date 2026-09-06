import { randomUUID } from 'crypto';
export function processCanaryAnalysis(input: any): any {
  let outcome = 'unknown';
  if (input.errorRate !== undefined && input.availability !== undefined) {
    if (input.errorRate < 0.01 && input.availability > 0.99) outcome = 'healthy';
    else if (input.errorRate > 0.05 || input.availability < 0.95) outcome = 'unhealthy';
    else outcome = 'degraded';
  }
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    errorRate: input.errorRate,
    availability: input.availability,
    outcome,
  };
}
