import { randomUUID } from 'crypto';
export function processObservabilitySource(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    name: input.name,
    provider: input.provider || 'unknown',
    sourceType: input.sourceType || 'unknown',
    environment: input.environment || null,
    owner: input.owner || null,
    capabilities: input.capabilities || [],
    healthState: input.healthState || 'unknown',
    configFingerprint: input.configFingerprint || null,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
