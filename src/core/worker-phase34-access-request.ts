import { randomUUID } from 'crypto';

export interface AccessRequest {
  requestId: string;
  identityId: string;
  resource: string;
  action: string;
  environment: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  policyDecision: string;
  approvalRequired: boolean;
  approved: boolean;
  createdAt: string;
  idempotencyKey: string;
}

export function createAccessRequest(input: Omit<AccessRequest, 'requestId' | 'createdAt' | 'idempotencyKey' | 'approved'> & { idempotencyKey?: string }): AccessRequest {
  const idempotencyKey = input.idempotencyKey ?? `${input.identityId}:${input.resource}:${input.action}`;
  return { requestId: randomUUID(), ...input, approved: false, createdAt: new Date().toISOString(), idempotencyKey };
}
