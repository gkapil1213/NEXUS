import { randomUUID } from 'crypto';

export interface RemediationPlan {
  planId: string;
  opportunityId: string;
  actions: string[];
  risk: string;
  blastRadius: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRemediationPlan(input: Omit<RemediationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): RemediationPlan {
  const idempotencyKey = input.idempotencyKey ?? input.opportunityId;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
