import { randomUUID } from 'crypto';

export type ResourceType = 'COMPUTE' | 'STORAGE' | 'NETWORK' | 'DATABASE' | 'CONTAINER' | 'SERVERLESS' | 'QUEUE' | 'OTHER';
export type ResourceHealth = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface InfrastructureResource {
  resourceId: string;
  provider: string;
  account: string;
  region: string;
  environment: string;
  type: ResourceType;
  resourceName: string;
  lifecycleState: string;
  health: ResourceHealth;
  owner: string;
  tags: Record<string, string>;
  dependencies: string[];
  criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  workload: string;
  securityClassification: string;
  costCenter: string;
  currentCapacity: number;
  allocatedCapacity: number;
  utilizedCapacity: number;
  desiredCapacity: number;
  minCapacity: number;
  maxCapacity: number;
  lastObservation: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  idempotencyKey: string;
}

export function createInfrastructureResource(
  input: Omit<InfrastructureResource, 'resourceId' | 'createdAt' | 'updatedAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): InfrastructureResource {
  const fingerprint = `${input.provider}:${input.account}:${input.region}:${input.resourceName}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return { resourceId: randomUUID(), ...input, createdAt: now, updatedAt: now, fingerprint, idempotencyKey };
}
