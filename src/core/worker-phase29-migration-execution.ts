import { randomUUID } from 'crypto';

export type MigrationExecutionStatus = 'PLANNED' | 'APPROVED' | 'READY' | 'RUNNING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'ROLLBACK_REQUIRED' | 'ROLLING_BACK' | 'ROLLED_BACK';

export interface MigrationExecution {
  executionId: string;
  migrationId: string;
  status: MigrationExecutionStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<MigrationExecutionStatus, MigrationExecutionStatus[]> = {
  PLANNED: ['APPROVED', 'ROLLBACK_REQUIRED'],
  APPROVED: ['READY', 'ROLLBACK_REQUIRED'],
  READY: ['RUNNING', 'ROLLBACK_REQUIRED'],
  RUNNING: ['VERIFYING', 'FAILED', 'ROLLBACK_REQUIRED'],
  VERIFYING: ['SUCCEEDED', 'FAILED', 'ROLLBACK_REQUIRED'],
  SUCCEEDED: [],
  FAILED: ['ROLLBACK_REQUIRED', 'ROLLING_BACK'],
  ROLLBACK_REQUIRED: ['ROLLING_BACK'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
};

export function createMigrationExecution(
  input: Omit<MigrationExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): MigrationExecution {
  const idempotencyKey = input.idempotencyKey ?? input.migrationId;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionMigrationExecution(exec: MigrationExecution, next: MigrationExecutionStatus): MigrationExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal migration transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
