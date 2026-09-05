import { randomUUID } from 'crypto';

export interface RemediationPlan {
  planId: string;
  incidentId: string;
  actions: string[];
  expectedOutcome: string;
  risk: string;
  prerequisites: string[];
  safetyChecks: string[];
  rollbackPlan: string;
  verificationPlan: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createRemediationPlan(
  input: Omit<RemediationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): RemediationPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.incidentId}:${input.actions.join(',')}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
