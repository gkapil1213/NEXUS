import { randomUUID } from 'crypto';

export type RemediationStatus = 'PLANNED' | 'AUTHORIZED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'BLOCKED';

export interface RemediationExecution {
  remediationId: string;
  planId: string;
  status: RemediationStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<RemediationStatus, RemediationStatus[]> = {
  PLANNED: ['AUTHORIZED', 'BLOCKED'],
  AUTHORIZED: ['RUNNING', 'BLOCKED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  SUCCEEDED: [],
  FAILED: ['ROLLED_BACK', 'BLOCKED'],
  ROLLED_BACK: [],
  BLOCKED: [],
};

export function createRemediationExecution(input: Omit<RemediationExecution, 'remediationId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): RemediationExecution {
  const idempotencyKey = input.idempotencyKey ?? input.planId;
  const now = new Date().toISOString();
  return { remediationId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionRemediationExecution(exec: RemediationExecution, next: RemediationStatus): RemediationExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal remediation transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
