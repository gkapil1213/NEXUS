import { randomUUID } from 'crypto';

export type GovernanceRemediationStatus = 'PLANNED' | 'APPROVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';

export interface GovernanceRemediationExecution {
  executionId: string;
  planId: string;
  status: GovernanceRemediationStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<GovernanceRemediationStatus, GovernanceRemediationStatus[]> = {
  PLANNED: ['APPROVED'],
  APPROVED: ['RUNNING'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  SUCCEEDED: [],
  FAILED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
};

export function createGovernanceRemediationExecution(input: Omit<GovernanceRemediationExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): GovernanceRemediationExecution {
  const idempotencyKey = input.idempotencyKey ?? input.planId;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionGovernanceRemediationExecution(exec: GovernanceRemediationExecution, next: GovernanceRemediationStatus): GovernanceRemediationExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal governance remediation transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
