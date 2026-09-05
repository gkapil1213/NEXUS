import { randomUUID } from 'crypto';

export type FleetExecutionStatus = 'PLANNED' | 'APPROVED' | 'RUNNING' | 'PAUSED' | 'HALTED' | 'SUCCEEDED' | 'FAILED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'BLOCKED';

export interface FleetExecution {
  executionId: string;
  planId: string;
  status: FleetExecutionStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<FleetExecutionStatus, FleetExecutionStatus[]> = {
  PLANNED: ['APPROVED', 'HALTED', 'BLOCKED'],
  APPROVED: ['RUNNING', 'HALTED'],
  RUNNING: ['PAUSED', 'HALTED', 'SUCCEEDED', 'FAILED', 'ROLLING_BACK'],
  PAUSED: ['RUNNING', 'HALTED'],
  HALTED: [],
  SUCCEEDED: [],
  FAILED: ['ROLLING_BACK', 'HALTED'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
  BLOCKED: [],
};

export function createFleetExecution(input: Omit<FleetExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): FleetExecution {
  const idempotencyKey = input.idempotencyKey ?? input.planId;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionFleetExecution(exec: FleetExecution, next: FleetExecutionStatus): FleetExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal fleet transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
