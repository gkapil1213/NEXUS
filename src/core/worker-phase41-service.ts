import { randomUUID } from 'crypto';
export function processService(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    name: input.name,
    provider: input.provider || 'unknown',
    environment: input.environment || null,
    version: input.version || null,
    owner: input.owner || null,
    criticality: input.criticality || 'unknown',
    protected: input.protected || false,
    healthState: input.healthState || 'unknown',
    reliabilityState: input.reliabilityState || 'unknown',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
