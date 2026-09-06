import { randomUUID } from 'crypto';
export function processResource(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    provider: input.provider || 'unknown',
    environment: input.environment || null,
    serviceId: input.serviceId || null,
    resourceType: input.resourceType || 'unknown',
    region: input.region || null,
    zone: input.zone || null,
    status: input.status || 'active',
    capacity: input.capacity || null,
    allocatedCapacity: input.allocatedCapacity || null,
    utilization: input.utilization || null,
    owner: input.owner || null,
    criticality: input.criticality || 'unknown',
    configFingerprint: input.configFingerprint || null,
    version: input.version || null,
    metadata: input.metadata || {},
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
