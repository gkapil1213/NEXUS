import { randomUUID } from 'crypto';

export type BackupJobStatus = 'PLANNED' | 'QUEUED' | 'RUNNING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface BackupJob {
  jobId: string;
  policyId: string;
  target: string;
  status: BackupJobStatus;
  startTime?: string;
  endTime?: string;
  provider: string;
  artifactId?: string;
  fingerprint: string;
  errorClassification?: string;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<BackupJobStatus, BackupJobStatus[]> = {
  PLANNED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['CANCELLED'],
  CANCELLED: [],
};

export function createBackupJob(
  input: Omit<BackupJob, 'jobId' | 'createdAt' | 'updatedAt' | 'status' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): BackupJob {
  const fingerprint = `${input.policyId}:${input.target}:${input.provider}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return { jobId: randomUUID(), ...input, status: 'PLANNED', fingerprint, createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionBackupJob(job: BackupJob, next: BackupJobStatus): BackupJob {
  if (!VALID_TRANSITIONS[job.status].includes(next)) throw new Error(`Illegal backup transition ${job.status}->${next}`);
  const updated = { ...job, status: next, updatedAt: new Date().toISOString() };
  if (next === 'RUNNING') updated.startTime = updated.startTime ?? new Date().toISOString();
  if (next === 'COMPLETED' || next === 'FAILED' || next === 'CANCELLED') updated.endTime = new Date().toISOString();
  return updated;
}
