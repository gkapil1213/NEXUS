import { randomUUID } from 'crypto';

export type EnvironmentType = 'DEVELOPMENT' | 'TEST' | 'STAGING' | 'PRODUCTION' | 'DISASTER_RECOVERY';

export interface PlatformEnvironment {
  environmentId: string;
  name: string;
  type: EnvironmentType;
  provider: string;
  region: string;
  account: string;
  cluster: string;
  lifecycleState: string;
  healthState: string;
  criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  protectionLevel: string;
  production: boolean;
  drRelationship: string;
  configurationFingerprint: string;
  versionFingerprint: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export function createPlatformEnvironment(
  input: Omit<PlatformEnvironment, 'environmentId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): PlatformEnvironment {
  const idempotencyKey = input.idempotencyKey ?? `${input.name}:${input.type}:${input.provider}:${input.account}`;
  const now = new Date().toISOString();
  return { environmentId: randomUUID(), ...input, createdAt: now, updatedAt: now, idempotencyKey };
}
