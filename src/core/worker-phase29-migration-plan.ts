import { randomUUID } from 'crypto';

export interface MigrationPlan {
  migrationId: string;
  resourceId: string;
  sourceSchema: string;
  targetSchema: string;
  operations: string[];
  preconditions: string[];
  safetyClassification: string;
  governanceRequirements: string[];
  rollbackPlan: string;
  verificationPlan: string;
  risk: string;
  impact: string;
  blastRadius: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createMigrationPlan(
  input: Omit<MigrationPlan, 'migrationId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): MigrationPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.resourceId}:${input.sourceSchema}:${input.targetSchema}`;
  return { migrationId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
