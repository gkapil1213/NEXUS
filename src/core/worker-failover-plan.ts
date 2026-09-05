import { randomUUID } from 'crypto';

export interface FailoverPlan {
  planId: string;
  primaryTarget: string;
  secondaryTarget: string;
  dependencies: string[];
  ordering: string[];
  healthRequirements: string[];
  governanceRequirements: string[];
  safetyRequirements: string[];
  approvalRequired: boolean;
  failbackStrategy: string;
  fingerprint: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createFailoverPlan(
  input: Omit<FailoverPlan, 'planId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): FailoverPlan {
  const fingerprint = `${input.primaryTarget}:${input.secondaryTarget}:${input.dependencies.join(',')}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return { planId: randomUUID(), ...input, fingerprint, createdAt: new Date().toISOString(), idempotencyKey };
}
