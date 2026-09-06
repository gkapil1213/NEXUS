import { randomUUID } from 'crypto';
export function processReleaseHealth(input: any): any {
  let health = 'UNKNOWN';
  if (input.errorRate !== undefined && input.availability !== undefined) {
    if (input.errorRate < 0.01 && input.availability > 0.99) health = 'HEALTHY';
    else if (input.errorRate > 0.05 || input.availability < 0.95) health = 'UNHEALTHY';
    else health = 'DEGRADED';
  }
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    health,
    errorRate: input.errorRate,
    availability: input.availability,
    observedAt: new Date().toISOString(),
  };
}
