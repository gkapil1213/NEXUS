import { randomUUID } from 'crypto';

export type RemediationExecutionStatus = 'PLANNED' | 'APPROVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';

export interface RemediationExecution {
  executionId: string;
  planId: string;
  status: RemediationExecutionStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<RemediationExecutionStatus, RemediationExecutionStatus[]> = {
  PLANNED: ['APPROVED'],
  APPROVED: ['RUNNING'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  SUCCEEDED: [],
  FAILED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
};

export function createRemediationExecution(input: Omit<RemediationExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): RemediationExecution {
  const idempotencyKey = input.idempotencyKey ?? input.planId;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionRemediationExecution(exec: RemediationExecution, next: RemediationExecutionStatus): RemediationExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal remediation transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
