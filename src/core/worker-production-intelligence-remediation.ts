import { randomUUID } from 'crypto';

export interface RemediationPlan {
  planId: string;
  incidentId: string;
  hypothesisId: string;
  actionType: string;
  target: string;
  parameters: Record<string, unknown>;
  expectedOutcome: string;
  riskLevel: string;
  rollbackCapability: boolean;
  verificationStrategy: string;
  authorizationRequired: boolean;
  idempotencyKey: string;
  createdAt: string;
}

export function createRemediationPlan(
  input: Omit<RemediationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): RemediationPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.incidentId}:${input.actionType}:${input.target}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
