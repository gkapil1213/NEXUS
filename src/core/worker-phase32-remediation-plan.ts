import { randomUUID } from 'crypto';

export interface GovernanceRemediationPlan {
  planId: string;
  violationId: string;
  actions: string[];
  risk: string;
  blastRadius: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createGovernanceRemediationPlan(input: Omit<GovernanceRemediationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): GovernanceRemediationPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.violationId}:${input.actions.join(',')}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
