import { randomUUID } from 'crypto';

export type RestoreJobStatus = 'PLANNED' | 'AUTHORIZED' | 'RUNNING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'ROLLED_BACK';

export interface RestoreJob {
  restoreId: string;
  recoveryPointId: string;
  target: string;
  status: RestoreJobStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<RestoreJobStatus, RestoreJobStatus[]> = {
  PLANNED: ['AUTHORIZED', 'ROLLED_BACK'],
  AUTHORIZED: ['RUNNING', 'ROLLED_BACK'],
  RUNNING: ['VERIFYING', 'FAILED'],
  VERIFYING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
};

export function createRestoreJob(
  input: Omit<RestoreJob, 'restoreId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): RestoreJob {
  const idempotencyKey = input.idempotencyKey ?? `${input.recoveryPointId}:${input.target}`;
  const now = new Date().toISOString();
  return { restoreId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionRestoreJob(job: RestoreJob, next: RestoreJobStatus): RestoreJob {
  if (!VALID_TRANSITIONS[job.status].includes(next)) throw new Error(`Illegal restore transition ${job.status}->${next}`);
  return { ...job, status: next, updatedAt: new Date().toISOString() };
}
