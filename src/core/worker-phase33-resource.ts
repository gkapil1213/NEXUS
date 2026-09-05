import { randomUUID } from 'crypto';

export interface GovernedResource {
  resourceId: string;
  provider: string;
  account: string;
  environment: string;
  region: string;
  type: string;
  owner: string;
  team: string;
  application: string;
  lifecycleState: string;
  tags: Record<string, string>;
  configurationFingerprint: string;
  costMetadata: Record<string, unknown>;
  securityMetadata: Record<string, unknown>;
  complianceMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  idempotencyKey: string;
}

export function createGovernedResource(
  input: Omit<GovernedResource, 'resourceId' | 'createdAt' | 'updatedAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): GovernedResource {
  const fingerprint = `${input.provider}:${input.account}:${input.region}:${input.type}:${input.application}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return { resourceId: randomUUID(), ...input, fingerprint, createdAt: now, updatedAt: now, idempotencyKey };
}
