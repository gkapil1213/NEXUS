import { randomUUID } from 'crypto';

export interface GovernanceEvidence {
  evidenceId: string;
  decisionId: string;
  policyId: string;
  policyVersion: number;
  resourceId: string;
  controlId: string;
  risk: string;
  approvalId: string;
  exceptionId: string;
  timestamp: string;
  idempotencyKey: string;
}

export function createGovernanceEvidence(input: Omit<GovernanceEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }): GovernanceEvidence {
  const idempotencyKey = input.idempotencyKey ?? input.decisionId;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
