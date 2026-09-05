import { randomUUID } from 'crypto';

export interface ApplicationResource {
  resourceId: string;
  applicationName: string;
  serviceName: string;
  environment: string;
  version: string;
  runtimeType: string;
  deploymentRef: string;
  owner: string;
  criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  protectionLevel: string;
  provider: string;
  region: string;
  healthState: string;
  lifecycleState: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  idempotencyKey: string;
}

export function createApplicationResource(
  input: Omit<ApplicationResource, 'resourceId' | 'createdAt' | 'updatedAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): ApplicationResource {
  const fingerprint = `${input.applicationName}:${input.serviceName}:${input.environment}:${input.version}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return { resourceId: randomUUID(), ...input, createdAt: now, updatedAt: now, fingerprint, idempotencyKey };
}
