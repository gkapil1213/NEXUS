import { randomUUID } from 'crypto';

export interface RemediationPlan {
  planId: string;
  serviceId: string;
  actions: string[];
  reason: string;
  risk: string;
  blastRadius: string;
  governanceRequirement: string;
  rollbackStrategy: string;
  verificationStrategy: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRemediationPlan(input: Omit<RemediationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): RemediationPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.serviceId}:${input.actions.join(',')}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
