import { randomUUID } from 'crypto';

export type ContainmentStatus = 'PLANNED' | 'AUTHORIZED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'BLOCKED';

export interface ContainmentExecution {
  containmentId: string;
  incidentId: string;
  action: string;
  status: ContainmentStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<ContainmentStatus, ContainmentStatus[]> = {
  PLANNED: ['AUTHORIZED', 'BLOCKED'],
  AUTHORIZED: ['RUNNING', 'BLOCKED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  SUCCEEDED: [],
  FAILED: ['ROLLED_BACK', 'BLOCKED'],
  ROLLED_BACK: [],
  BLOCKED: [],
};

export function createContainmentExecution(input: Omit<ContainmentExecution, 'containmentId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): ContainmentExecution {
  const idempotencyKey = input.idempotencyKey ?? `${input.incidentId}:${input.action}`;
  const now = new Date().toISOString();
  return { containmentId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionContainment(exec: ContainmentExecution, next: ContainmentStatus): ContainmentExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal containment transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
