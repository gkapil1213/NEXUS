import { randomUUID } from 'crypto';

export type StageStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';

export interface StageExecution {
  stageExecutionId: string;
  executionId: string;
  stageName: string;
  attempt: number;
  status: StageStatus;
  executor: string;
  inputFingerprint: string;
  outputFingerprint?: string;
  logsReference?: string;
  artifactReferences: string[];
  failureReason?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export function createStageExecution(
  input: Omit<StageExecution, 'stageExecutionId' | 'createdAt' | 'updatedAt' | 'status' | 'attempt' | 'idempotencyKey'> & { idempotencyKey?: string; attempt?: number }
): StageExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.executionId}:${input.stageName}:${input.attempt ?? 1}`;
  const now = new Date().toISOString();
  return {
    stageExecutionId: randomUUID(),
    ...input,
    attempt: input.attempt ?? 1,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function transitionStageExecution(stage: StageExecution, next: StageStatus): StageExecution {
  const allowed: Record<StageStatus, StageStatus[]> = {
    PENDING: ['RUNNING', 'SKIPPED', 'CANCELLED'],
    RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
    SUCCEEDED: [],
    FAILED: ['RUNNING'], // retry
    SKIPPED: [],
    CANCELLED: [],
  };
  if (!allowed[stage.status].includes(next)) {
    throw new Error(`Illegal stage transition from ${stage.status} to ${next}`);
  }
  const updated = { ...stage, status: next, updatedAt: new Date().toISOString() };
  if (next === 'RUNNING') updated.startedAt = updated.startedAt ?? new Date().toISOString();
  if (['SUCCEEDED','FAILED','CANCELLED','SKIPPED'].includes(next)) updated.endedAt = new Date().toISOString();
  return updated;
}
