import { randomUUID } from 'crypto';

export type RemediationExecutionStatus = 'PLANNED' | 'AUTHORIZED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'RECOVERY' | 'BLOCKED';

export interface RemediationExecution {
  executionId: string;
  planId: string;
  status: RemediationExecutionStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<RemediationExecutionStatus, RemediationExecutionStatus[]> = {
  PLANNED: ['AUTHORIZED', 'BLOCKED'],
  AUTHORIZED: ['EXECUTING', 'BLOCKED'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'RECOVERY'],
  SUCCEEDED: [],
  FAILED: ['RECOVERY', 'BLOCKED'],
  RECOVERY: ['EXECUTING', 'FAILED', 'BLOCKED'],
  BLOCKED: [],
};

export function createRemediationExecution(
  input: Omit<RemediationExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'attempt' | 'idempotencyKey'> & { idempotencyKey?: string; attempt?: number }
): RemediationExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.planId}:${input.correlationId}`;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', attempt: input.attempt ?? 1, createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionRemediationExecution(execution: RemediationExecution, next: RemediationExecutionStatus): RemediationExecution {
  if (!VALID_TRANSITIONS[execution.status].includes(next)) {
    throw new Error(`Illegal remediation transition from ${execution.status} to ${next}`);
  }
  return { ...execution, status: next, updatedAt: new Date().toISOString() };
}
