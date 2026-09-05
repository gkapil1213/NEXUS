import { randomUUID } from 'crypto';

export interface RemediationPlan {
  planId: string;
  incidentId: string;
  actions: string[];
  risk: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRemediationPlan(input: Omit<RemediationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): RemediationPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.incidentId}:${input.actions.join(',')}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
