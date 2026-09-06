import { randomUUID } from 'crypto';
export function processResource(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    provider: input.provider || 'unknown',
    environment: input.environment || null,
    resourceType: input.resourceType || 'unknown',
    region: input.region || null,
    zone: input.zone || null,
    owner: input.owner || null,
    criticality: input.criticality || 'unknown',
    currentCapacity: input.currentCapacity || null,
    minCapacity: input.minCapacity || null,
    maxCapacity: input.maxCapacity || null,
    scalingCapability: input.scalingCapability || null,
    scalingConstraints: input.scalingConstraints || null,
    status: input.status || 'active',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
