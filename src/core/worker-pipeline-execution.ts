import { randomUUID } from 'crypto';

export type PipelineExecutionStatus = 'QUEUED' | 'RUNNING' | 'PAUSED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

export interface PipelineExecution {
  executionId: string;
  pipelineId: string;
  pipelineVersion: number;
  repository: string;
  revision: string;
  status: PipelineExecutionStatus;
  actor: string;
  trigger: string;
  idempotencyKey: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

const VALID_TRANSITIONS: Record<PipelineExecutionStatus, PipelineExecutionStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

export function createPipelineExecution(
  input: Omit<PipelineExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): PipelineExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.pipelineId}:${input.pipelineVersion}:${input.revision}:${input.correlationId}`;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'QUEUED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionPipelineExecution(execution: PipelineExecution, next: PipelineExecutionStatus): PipelineExecution {
  if (!VALID_TRANSITIONS[execution.status].includes(next)) {
    throw new Error(`Illegal pipeline transition from ${execution.status} to ${next}`);
  }
  return { ...execution, status: next, updatedAt: new Date().toISOString() };
}
