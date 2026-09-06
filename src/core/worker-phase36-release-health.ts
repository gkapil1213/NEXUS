import { randomUUID } from 'crypto';
export function processReleaseHealth(input: any): any {
  let health = 'UNKNOWN';
  if (input.errorRate !== undefined && input.errorRate < 0.01 && input.availability > 0.99) health = 'HEALTHY';
  else if (input.errorRate !== undefined && input.errorRate > 0.05) health = 'UNHEALTHY';
  else if (input.errorRate !== undefined) health = 'DEGRADED';
  return { id: randomUUID(), releaseId: input.releaseId, health };
}
