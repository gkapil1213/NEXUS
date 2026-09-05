import { randomUUID } from 'crypto';

export type DeploymentExecutionStatus = 'PLANNED' | 'APPROVAL_PENDING' | 'APPROVED' | 'STARTING' | 'RUNNING' | 'PAUSED' | 'SUCCEEDED' | 'FAILED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'CANCELLED';

export interface DeploymentExecution {
  executionId: string;
  planId: string;
  status: DeploymentExecutionStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<DeploymentExecutionStatus, DeploymentExecutionStatus[]> = {
  PLANNED: ['APPROVAL_PENDING', 'CANCELLED'],
  APPROVAL_PENDING: ['APPROVED', 'CANCELLED'],
  APPROVED: ['STARTING', 'CANCELLED'],
  STARTING: ['RUNNING', 'FAILED'],
  RUNNING: ['PAUSED', 'SUCCEEDED', 'FAILED', 'ROLLING_BACK'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: ['ROLLING_BACK', 'CANCELLED'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
  CANCELLED: [],
};

export function createDeploymentExecution(
  input: Omit<DeploymentExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): DeploymentExecution {
  const idempotencyKey = input.idempotencyKey ?? input.planId;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionDeploymentExecution(exec: DeploymentExecution, next: DeploymentExecutionStatus): DeploymentExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal deployment transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
