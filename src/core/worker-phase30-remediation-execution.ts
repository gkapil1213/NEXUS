import { randomUUID } from 'crypto';

export type RemediationExecutionStatus = 'PLANNED' | 'APPROVED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'ROLLBACK_PENDING' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'HALTED';

export interface RemediationExecution {
  executionId: string;
  planId: string;
  status: RemediationExecutionStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<RemediationExecutionStatus, RemediationExecutionStatus[]> = {
  PLANNED: ['APPROVED', 'HALTED'],
  APPROVED: ['EXECUTING', 'HALTED'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'HALTED'],
  SUCCEEDED: [],
  FAILED: ['ROLLBACK_PENDING', 'HALTED'],
  ROLLBACK_PENDING: ['ROLLING_BACK'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
  HALTED: [],
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
