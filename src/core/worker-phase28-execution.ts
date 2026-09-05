import { randomUUID } from 'crypto';

export type InfrastructureExecutionStatus = 'PLANNED' | 'APPROVED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'HALTED' | 'ROLLED_BACK';

export interface InfrastructureExecution {
  executionId: string;
  planId: string;
  status: InfrastructureExecutionStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<InfrastructureExecutionStatus, InfrastructureExecutionStatus[]> = {
  PLANNED: ['APPROVED', 'HALTED'],
  APPROVED: ['EXECUTING', 'HALTED'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'HALTED', 'ROLLED_BACK'],
  SUCCEEDED: [],
  FAILED: ['ROLLED_BACK', 'HALTED'],
  HALTED: [],
  ROLLED_BACK: [],
};

export function createInfrastructureExecution(input: Omit<InfrastructureExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): InfrastructureExecution {
  const idempotencyKey = input.idempotencyKey ?? input.planId;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionInfrastructureExecution(exec: InfrastructureExecution, next: InfrastructureExecutionStatus): InfrastructureExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal infrastructure transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
