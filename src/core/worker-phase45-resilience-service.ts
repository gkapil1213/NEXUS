import { randomUUID } from 'crypto';
export function processResilienceService(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    name: input.name,
    criticality: input.criticality || 'unknown',
    owner: input.owner || null,
    recoveryPriority: input.recoveryPriority || 0,
    recoveryStrategy: input.recoveryStrategy || null,
    rtoTarget: input.rtoTarget || null,
    rpoTarget: input.rpoTarget || null,
    resilienceStatus: input.resilienceStatus || 'unknown',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
