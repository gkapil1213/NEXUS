import { randomUUID } from 'crypto';
export function processResource(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    provider: input.provider || 'unknown',
    resourceType: input.resourceType || 'unknown',
    environment: input.environment || null,
    region: input.region || null,
    zone: input.zone || null,
    owner: input.owner || null,
    team: input.team || null,
    serviceId: input.serviceId || null,
    project: input.project || null,
    criticality: input.criticality || 'unknown',
    protectionState: input.protectionState || 'unprotected',
    status: input.status || 'active',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
