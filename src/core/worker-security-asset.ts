import { randomUUID } from 'crypto';

export type AssetType = 'APPLICATION' | 'SERVICE' | 'API' | 'WORKER' | 'DEPLOYMENT_TARGET' | 'ENVIRONMENT' | 'ARTIFACT' | 'RELEASE' | 'INFRASTRUCTURE' | 'DATABASE' | 'QUEUE' | 'EXTERNAL_DEPENDENCY' | 'SECRET_REFERENCE' | 'CONFIGURATION';

export interface SecurityAsset {
  assetId: string;
  type: AssetType;
  environment: string;
  owner?: string;
  source: string;
  status: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';
  identifiers: Record<string, string>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createSecurityAsset(
  input: Omit<SecurityAsset, 'assetId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): SecurityAsset {
  const idempotencyKey = input.idempotencyKey ?? `${input.type}:${input.environment}:${input.source}:${JSON.stringify(input.identifiers)}`;
  const now = new Date().toISOString();
  return { assetId: randomUUID(), ...input, createdAt: now, updatedAt: now, idempotencyKey };
}
