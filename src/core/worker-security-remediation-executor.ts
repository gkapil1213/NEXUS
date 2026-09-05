import { randomUUID } from 'crypto';

export type SecurityRemediationStatus = 'PLANNED' | 'AUTHORIZED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'RECOVERY' | 'BLOCKED';

export interface SecurityRemediationExecution {
  executionId: string;
  planId: string;
  status: SecurityRemediationStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<SecurityRemediationStatus, SecurityRemediationStatus[]> = {
  PLANNED: ['AUTHORIZED', 'BLOCKED'],
  AUTHORIZED: ['EXECUTING', 'BLOCKED'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'RECOVERY'],
  SUCCEEDED: [],
  FAILED: ['RECOVERY', 'BLOCKED'],
  RECOVERY: ['EXECUTING', 'FAILED', 'BLOCKED'],
  BLOCKED: [],
};

export function createSecurityRemediationExecution(
  input: Omit<SecurityRemediationExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'attempt' | 'idempotencyKey'> & { idempotencyKey?: string; attempt?: number }
): SecurityRemediationExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.planId}:${input.correlationId}`;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', attempt: input.attempt ?? 1, createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionSecurityRemediationExecution(execution: SecurityRemediationExecution, next: SecurityRemediationStatus): SecurityRemediationExecution {
  if (!VALID_TRANSITIONS[execution.status].includes(next)) {
    throw new Error(`Illegal security remediation transition from ${execution.status} to ${next}`);
  }
  return { ...execution, status: next, updatedAt: new Date().toISOString() };
}
