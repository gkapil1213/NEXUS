import { randomUUID } from 'crypto';

export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export type PolicyDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL' | 'UNKNOWN';

export interface GovernancePolicy {
  policyId: string;
  version: number;
  status: PolicyStatus;
  name: string;
  description: string;
  riskThreshold: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  autoApproveBelow: 'LOW' | 'MEDIUM' | 'HIGH';
  requireSeparationOfDuties: boolean;
  minApprovals: number;
  emergencyAllowed: boolean;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<PolicyStatus, PolicyStatus[]> = {
  DRAFT: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['RETIRED'],
  RETIRED: [],
};

export function createGovernancePolicy(
  input: Omit<GovernancePolicy, 'policyId' | 'createdAt' | 'updatedAt' | 'status' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string; status?: PolicyStatus }
): GovernancePolicy {
  const fingerprint = `${input.name}:${input.version}:${input.riskThreshold}:${input.autoApproveBelow}:${input.minApprovals}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return {
    policyId: randomUUID(),
    ...input,
    status: input.status ?? 'DRAFT',
    fingerprint,
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function transitionPolicy(policy: GovernancePolicy, next: PolicyStatus): GovernancePolicy {
  if (!VALID_TRANSITIONS[policy.status].includes(next)) {
    throw new Error(`Illegal policy transition from ${policy.status} to ${next}`);
  }
  return { ...policy, status: next, updatedAt: new Date().toISOString() };
}

export function evaluatePolicy(policy: GovernancePolicy, risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): PolicyDecision {
  if (policy.status !== 'ACTIVE') return 'UNKNOWN';
  const order: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  if (order.indexOf(risk) <= order.indexOf(policy.autoApproveBelow)) return 'ALLOW';
  if (order.indexOf(risk) <= order.indexOf(policy.riskThreshold)) return 'REQUIRES_APPROVAL';
  return 'DENY';
}
