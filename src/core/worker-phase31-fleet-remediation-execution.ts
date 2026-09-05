import { randomUUID } from 'crypto';

export type FleetRemediationStatus = 'PLANNED' | 'APPROVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';

export interface FleetRemediationExecution {
  executionId: string;
  planId: string;
  status: FleetRemediationStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<FleetRemediationStatus, FleetRemediationStatus[]> = {
  PLANNED: ['APPROVED'],
  APPROVED: ['RUNNING'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  SUCCEEDED: [],
  FAILED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
};

export function createFleetRemediationExecution(input: Omit<FleetRemediationExecution, 'executionId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): FleetRemediationExecution {
  const idempotencyKey = input.idempotencyKey ?? input.planId;
  const now = new Date().toISOString();
  return { executionId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionFleetRemediationExecution(exec: FleetRemediationExecution, next: FleetRemediationStatus): FleetRemediationExecution {
  if (!VALID_TRANSITIONS[exec.status].includes(next)) throw new Error(`Illegal fleet remediation transition ${exec.status}->${next}`);
  return { ...exec, status: next, updatedAt: new Date().toISOString() };
}
