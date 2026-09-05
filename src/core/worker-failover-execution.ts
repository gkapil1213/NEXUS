import { randomUUID } from 'crypto';

export type FailoverStatus = 'PLANNED' | 'AUTHORIZED' | 'PREPARING' | 'FAILING_OVER' | 'VERIFYING' | 'COMPLETED' | 'PAUSED' | 'ABORTED' | 'FAILED';

export interface FailoverExecution {
  executionId: string;
  planId: string;
  status: FailoverStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<FailoverStatus, FailoverStatus[]> = {
  PLANNED: ['AUTHORIZED', 'ABORTED'],
  AUTHORIZED: ['PREPARING', 'ABORTED'],
  PREPARING: ['FAILING_OVER', 'FAILED'],
  FAILING_OVER: ['VERIFYING', 'FAILED', 'ABORTED'],
  VERIFYING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  PAUSED: ['FAILING_OVER', 'ABORTED'],
  ABORTED: [],
  FAILED: [],
};

export function createFailoverExecution(
  input: Omit<FailoverExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): FailoverExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.planId}`;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionFailoverExecution(exec: FailoverExecution, next: FailoverStatus): FailoverExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal failover transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
