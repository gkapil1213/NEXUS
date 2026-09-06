import { randomUUID } from 'crypto';
export function processIncident(input: any): any {
  const fingerprint = input.fingerprint || input.idempotencyKey || randomUUID();
  return {
    id: fingerprint,
    fingerprint,
    status: input.status || 'detected',
    severity: input.severity || 'unknown',
    priority: input.priority || 3,
    source: input.source || null,
    environment: input.environment || null,
    serviceId: input.serviceId || null,
    resourceId: input.resourceId || null,
    commander: input.commander || null,
    correlationState: input.correlationState || 'open',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
