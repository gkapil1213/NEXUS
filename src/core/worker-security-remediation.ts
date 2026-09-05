import { randomUUID } from 'crypto';

export interface SecurityRemediationPlan {
  planId: string;
  findingId: string;
  assetId: string;
  action: string;
  riskLevel: string;
  expectedOutcome: string;
  rollbackCapability: boolean;
  verificationStrategy: string;
  authorizationRequired: boolean;
  policyDecision: string;
  safetyDecision: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createSecurityRemediationPlan(
  input: Omit<SecurityRemediationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): SecurityRemediationPlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.findingId}:${input.action}:${input.assetId}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
