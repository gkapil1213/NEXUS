import { randomUUID } from 'crypto';

export type DeploymentExecutionStatus = 'PLANNED' | 'APPROVED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'ROLLED_BACK' | 'CANCELLED';

export interface DeploymentExecution {
  executionId: string;
  releaseId: string;
  environmentId: string;
  executionMode: 'REAL' | 'DRY_RUN' | 'SIMULATION';
  status: DeploymentExecutionStatus;
  startedAt?: string;
  endedAt?: string;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<DeploymentExecutionStatus, DeploymentExecutionStatus[]> = {
  PLANNED: ['APPROVED', 'CANCELLED'],
  APPROVED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'ROLLED_BACK'],
  SUCCEEDED: [],
  PARTIAL: [],
  FAILED: ['ROLLED_BACK', 'CANCELLED'],
  ROLLED_BACK: [],
  CANCELLED: [],
};

export function createDeploymentExecution(
  input: Omit<DeploymentExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): DeploymentExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.releaseId}:${input.environmentId}:${input.executionMode}`;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionDeploymentExecution(execution: DeploymentExecution, next: DeploymentExecutionStatus): DeploymentExecution {
  if (!VALID_TRANSITIONS[execution.status].includes(next)) {
    throw new Error(`Illegal deployment transition from ${execution.status} to ${next}`);
  }
  const updated = { ...execution, status: next, updatedAt: new Date().toISOString() };
  if (next === 'RUNNING') updated.startedAt = updated.startedAt ?? new Date().toISOString();
  if (['SUCCEEDED','PARTIAL','FAILED','ROLLED_BACK','CANCELLED'].includes(next)) updated.endedAt = new Date().toISOString();
  return updated;
}
