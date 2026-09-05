import { randomUUID } from 'crypto';

export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'RETIRED';

export interface GovernancePolicy {
  policyId: string;
  name: string;
  description: string;
  type: string;
  scope: string;
  severity: string;
  priority: number;
  version: number;
  status: PolicyStatus;
  effectiveAt: string;
  expiresAt: string;
  owner: string;
  controlMappings: string[];
  conditions: Record<string, unknown>;
  actions: string[];
  exceptions: string[];
  approvalRequired: boolean;
  enforcementMode: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<PolicyStatus, PolicyStatus[]> = {
  DRAFT: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['SUSPENDED', 'EXPIRED', 'RETIRED'],
  SUSPENDED: ['ACTIVE', 'RETIRED'],
  EXPIRED: ['RETIRED'],
  RETIRED: [],
};

export function createGovernancePolicy(
  input: Omit<GovernancePolicy, 'policyId' | 'createdAt' | 'updatedAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): GovernancePolicy {
  const fingerprint = `${input.name}:${input.type}:${input.scope}:${input.version}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return { policyId: randomUUID(), ...input, fingerprint, createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionPolicy(policy: GovernancePolicy, next: PolicyStatus): GovernancePolicy {
  if (!VALID_TRANSITIONS[policy.status].includes(next)) throw new Error(`Illegal policy transition ${policy.status}->${next}`);
  return { ...policy, status: next, updatedAt: new Date().toISOString() };
}
