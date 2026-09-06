import { randomUUID } from 'crypto';
export function processRecoveryAsset(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    name: input.name,
    provider: input.provider || 'unknown',
    environment: input.environment || null,
    assetType: input.assetType || 'unknown',
    owner: input.owner || null,
    criticality: input.criticality || 'unknown',
    recoveryCapability: input.recoveryCapability || null,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
