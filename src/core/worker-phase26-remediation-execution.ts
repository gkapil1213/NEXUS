import { randomUUID } from 'crypto';

export type RemediationExecutionStatus = 'PLANNED' | 'APPROVED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'BLOCKED';

export interface RemediationExecution {
  executionId: string;
  planId: string;
  status: RemediationExecutionStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<RemediationExecutionStatus, RemediationExecutionStatus[]> = {
  PLANNED: ['APPROVED', 'BLOCKED'],
  APPROVED: ['EXECUTING', 'BLOCKED'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  SUCCEEDED: [],
  FAILED: ['ROLLED_BACK', 'BLOCKED'],
  ROLLED_BACK: [],
  BLOCKED: [],
};

export function createRemediationExecution(
  input: Omit<RemediationExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'attempt' | 'idempotencyKey'> & { idempotencyKey?: string; attempt?: number }
): RemediationExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.planId}`;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', attempt: input.attempt ?? 1, createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionRemediationExecution(exec: RemediationExecution, next: RemediationExecutionStatus): RemediationExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal remediation transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
