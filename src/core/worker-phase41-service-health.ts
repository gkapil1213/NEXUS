import { randomUUID } from 'crypto';
export function processServiceHealth(input: any): any {
  let health = 'unknown';
  if (input.availability !== undefined && input.errorRate !== undefined) {
    if (input.availability > 0.99 && input.errorRate < 0.01) health = 'healthy';
    else if (input.availability > 0.95 && input.errorRate < 0.05) health = 'degraded';
    else health = 'unhealthy';
  }
  return { id: randomUUID(), serviceId: input.serviceId, health };
}
