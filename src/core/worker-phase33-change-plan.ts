import { randomUUID } from 'crypto';

export interface ChangePlan {
  planId: string;
  action: string;
  target: string;
  reason: string;
  expectedResult: string;
  policyDecision: string;
  approvalRequired: boolean;
  blastRadius: string;
  risk: string;
  rollbackStrategy: string;
  verificationStrategy: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createChangePlan(input: Omit<ChangePlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): ChangePlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.target}:${input.action}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
