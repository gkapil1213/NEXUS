import { randomUUID } from 'crypto';

export type DeploymentExecutionStatus = 'PLANNED' | 'PRECHECKING' | 'APPROVED' | 'EXECUTING' | 'ROLLOUT' | 'VERIFYING' | 'PROMOTING' | 'SUCCEEDED' | 'PAUSED' | 'FAILED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'RECOVERING' | 'CANCELLED';

export interface DeploymentExecution {
  executionId: string;
  planId: string;
  status: DeploymentExecutionStatus;
  startedAt?: string;
  endedAt?: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

const VALID_TRANSITIONS: Record<DeploymentExecutionStatus, DeploymentExecutionStatus[]> = {
  PLANNED: ['PRECHECKING', 'CANCELLED'],
  PRECHECKING: ['APPROVED', 'FAILED', 'CANCELLED'],
  APPROVED: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['ROLLOUT', 'FAILED', 'PAUSED'],
  ROLLOUT: ['VERIFYING', 'FAILED', 'PAUSED'],
  VERIFYING: ['PROMOTING', 'FAILED', 'PAUSED'],
  PROMOTING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  PAUSED: ['EXECUTING', 'ROLLOUT', 'VERIFYING', 'CANCELLED'],
  FAILED: ['ROLLING_BACK', 'RECOVERING', 'CANCELLED'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
  RECOVERING: ['EXECUTING', 'FAILED', 'CANCELLED'],
  CANCELLED: [],
};

export function createDeploymentExecution(
  input: Omit<DeploymentExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): DeploymentExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.planId}:${input.correlationId}`;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionDeploymentExecution(execution: DeploymentExecution, next: DeploymentExecutionStatus): DeploymentExecution {
  if (!VALID_TRANSITIONS[execution.status].includes(next)) {
    throw new Error(`Illegal deployment transition from ${execution.status} to ${next}`);
  }
  const updated: DeploymentExecution = { ...execution, status: next, updatedAt: new Date().toISOString() };
  if (next === 'EXECUTING') updated.startedAt = updated.startedAt ?? new Date().toISOString();
  if (['SUCCEEDED','FAILED','ROLLED_BACK','CANCELLED'].includes(next)) updated.endedAt = new Date().toISOString();
  return updated;
}
