import { randomUUID } from 'crypto';

export interface DatabaseResource {
  resourceId: string;
  provider: string;
  engine: string;
  environment: string;
  region: string;
  version: string;
  role: string;
  status: string;
  availability: number;
  capacity: number;
  storage: number;
  connections: number;
  replication: boolean;
  health: string;
  schemaVersion: string;
  protected: boolean;
  ownership: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  idempotencyKey: string;
}

export function createDatabaseResource(
  input: Omit<DatabaseResource, 'resourceId' | 'createdAt' | 'updatedAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): DatabaseResource {
  const fingerprint = `${input.provider}:${input.engine}:${input.environment}:${input.region}:${input.schemaVersion}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return {
    resourceId: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
    fingerprint,
    idempotencyKey,
  };
}
