import { randomUUID } from 'crypto';

export type IdentityType = 'HUMAN' | 'SERVICE' | 'MACHINE' | 'WORKLOAD' | 'APPLICATION' | 'AUTOMATION' | 'UNKNOWN';
export type IdentityStatus = 'DISCOVERED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED' | 'REVOKED' | 'EXPIRED' | 'DELETED' | 'UNKNOWN';

export interface Identity {
  identityId: string;
  type: IdentityType;
  name: string;
  provider: string;
  environment: string;
  status: IdentityStatus;
  owner: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<IdentityStatus, IdentityStatus[]> = {
  DISCOVERED: ['ACTIVE', 'SUSPENDED', 'DISABLED', 'UNKNOWN'],
  ACTIVE: ['SUSPENDED', 'DISABLED', 'REVOKED', 'EXPIRED'],
  SUSPENDED: ['ACTIVE', 'DISABLED'],
  DISABLED: ['ACTIVE', 'DELETED'],
  REVOKED: ['DELETED'],
  EXPIRED: ['DELETED'],
  DELETED: [],
  UNKNOWN: ['DISCOVERED', 'ACTIVE'],
};

export function createIdentity(
  input: Omit<Identity, 'identityId' | 'createdAt' | 'updatedAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): Identity {
  const fingerprint = `${input.type}:${input.name}:${input.provider}:${input.environment}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return { identityId: randomUUID(), ...input, fingerprint, createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionIdentity(identity: Identity, next: IdentityStatus): Identity {
  if (!VALID_TRANSITIONS[identity.status].includes(next)) throw new Error(`Illegal identity transition ${identity.status}->${next}`);
  return { ...identity, status: next, updatedAt: new Date().toISOString() };
}
