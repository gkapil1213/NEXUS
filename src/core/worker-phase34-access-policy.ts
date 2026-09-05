import { randomUUID } from 'crypto';

export interface AccessPolicy {
  policyId: string;
  name: string;
  effect: 'ALLOW' | 'DENY' | 'CONDITIONAL';
  conditions: Record<string, unknown>;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  createdAt: string;
  idempotencyKey: string;
}

export function createAccessPolicy(input: Omit<AccessPolicy, 'policyId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): AccessPolicy {
  const idempotencyKey = input.idempotencyKey ?? `${input.name}:${input.effect}`;
  return { policyId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
