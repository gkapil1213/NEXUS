import { randomUUID } from 'crypto';

export type ViolationStatus = 'OPEN' | 'ACKNOWLEDGED' | 'REMEDIATING' | 'RESOLVED' | 'WAIVED' | 'EXPIRED';

export interface PolicyViolation {
  violationId: string;
  policyId: string;
  policyVersion: number;
  controlId: string;
  resourceId: string;
  environment: string;
  severity: string;
  risk: string;
  status: ViolationStatus;
  firstDetected: string;
  lastDetected: string;
  owner: string;
  remediationStatus: string;
  evidence: string[];
  createdAt: string;
  idempotencyKey: string;
}

export function createPolicyViolation(input: Omit<PolicyViolation, 'violationId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): PolicyViolation {
  const idempotencyKey = input.idempotencyKey ?? `${input.policyId}:${input.controlId}:${input.resourceId}`;
  return { violationId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
