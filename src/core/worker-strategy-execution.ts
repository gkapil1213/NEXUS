import { randomUUID } from 'crypto';

export type StrategyExecutionStatus =
  | 'PLANNED'
  | 'VALIDATING'
  | 'APPROVED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'ROLLED_BACK'
  | 'CANCELLED'
  | 'BLOCKED';

export interface StrategyExecution {
  executionId: string;
  strategyId: string;
  strategyVersion: string;
  tenantId: string;
  actor: string;
  reason: string;
  environment: string;
  status: StrategyExecutionStatus;
  currentStepId?: string;
  startedAt?: string;
  endedAt?: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

const VALID_TRANSITIONS: Record<StrategyExecutionStatus, StrategyExecutionStatus[]> = {
  PLANNED: ['VALIDATING', 'CANCELLED', 'BLOCKED'],
  VALIDATING: ['APPROVED', 'BLOCKED', 'CANCELLED'],
  APPROVED: ['RUNNING', 'CANCELLED', 'BLOCKED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'FAILED', 'ROLLED_BACK', 'BLOCKED'],
  PAUSED: ['RUNNING', 'CANCELLED', 'BLOCKED'],
  COMPLETED: [],
  FAILED: ['ROLLED_BACK', 'CANCELLED'],
  ROLLED_BACK: [],
  CANCELLED: [],
  BLOCKED: [],
};

export function createStrategyExecution(
  input: Omit<StrategyExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & {
    idempotencyKey?: string;
  }
): StrategyExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.strategyId}:${input.correlationId}`;
  const now = new Date().toISOString();
  return {
    executionId: randomUUID(),
    ...input,
    status: 'PLANNED',
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function transitionExecution(
  execution: StrategyExecution,
  nextStatus: StrategyExecutionStatus
): StrategyExecution {
  if (!VALID_TRANSITIONS[execution.status].includes(nextStatus)) {
    throw new Error(`Illegal transition from ${execution.status} to ${nextStatus}`);
  }
  const updated: StrategyExecution = { ...execution, status: nextStatus, updatedAt: new Date().toISOString() };
  if (nextStatus === 'RUNNING') updated.startedAt = updated.startedAt ?? new Date().toISOString();
  if (['COMPLETED','FAILED','ROLLED_BACK','CANCELLED','BLOCKED'].includes(nextStatus)) {
    updated.endedAt = new Date().toISOString();
  }
  return updated;
}
