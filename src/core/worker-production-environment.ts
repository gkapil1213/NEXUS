import { randomUUID } from 'crypto';

export type EnvironmentType = 'LOCAL' | 'DEVELOPMENT' | 'TEST' | 'STAGING' | 'PRODUCTION';
export type EnvironmentHealth = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'UNAVAILABLE';

export interface ProductionEnvironment {
  environmentId: string;
  type: EnvironmentType;
  provider: string;
  region?: string;
  cluster?: string;
  account?: string;
  configurationFingerprint: string;
  health: EnvironmentHealth;
  availability: boolean;
  capabilities: string[];
  lastVerifiedAt: string;
  owner: string;
  policy: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createProductionEnvironment(
  input: Omit<ProductionEnvironment, 'environmentId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): ProductionEnvironment {
  const idempotencyKey = input.idempotencyKey ?? `${input.type}:${input.provider}:${input.account ?? ''}:${input.configurationFingerprint}`;
  const now = new Date().toISOString();
  return {
    environmentId: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function checkEnvironmentAvailability(env: ProductionEnvironment): { available: boolean; reason: string } {
  if (!env.availability) return { available: false, reason: 'environment marked unavailable' };
  if (env.health === 'UNAVAILABLE' || env.health === 'UNHEALTHY') return { available: false, reason: `environment health is ${env.health}` };
  return { available: true, reason: 'OK' };
}
