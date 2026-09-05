export type ExecutionStatus = 'PLANNED' | 'VALIDATING' | 'APPROVED' | 'RUNNING' | 'PAUSED' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'CANCELLED';

export interface ExecutionCycle {
  executionId: string;
  planId: string;
  portfolioId: string;
  status: ExecutionStatus;
  startedAt?: string;
  endedAt?: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

const VALID_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  PLANNED: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['APPROVED', 'CANCELLED'],
  APPROVED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['PAUSED', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'ROLLING_BACK', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  SUCCEEDED: [],
  PARTIAL: [],
  FAILED: ['ROLLING_BACK', 'CANCELLED'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
  CANCELLED: [],
};

export function createExecutionCycle(
  input: Omit<ExecutionCycle, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): ExecutionCycle {
  const idempotencyKey = input.idempotencyKey ?? `${input.portfolioId}:${input.planId}:${input.correlationId}`;
  const now = new Date().toISOString();
  return { executionId: `exec-${input.planId}-${Date.now()}`, ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionExecutionCycle(cycle: ExecutionCycle, next: ExecutionStatus): ExecutionCycle {
  if (!VALID_TRANSITIONS[cycle.status].includes(next)) {
    throw new Error(`Illegal transition from ${cycle.status} to ${next}`);
  }
  const updated: ExecutionCycle = { ...cycle, status: next, updatedAt: new Date().toISOString() };
  if (next === 'RUNNING') updated.startedAt = updated.startedAt ?? new Date().toISOString();
  if (['SUCCEEDED','PARTIAL','FAILED','ROLLED_BACK','CANCELLED'].includes(next)) updated.endedAt = new Date().toISOString();
  return updated;
}
