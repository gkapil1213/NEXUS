import { randomUUID } from 'crypto';

export interface AdaptationProposal {
  proposalId: string;
  strategyId: string;
  lineage: string[];
  failureEvidence: string[];
  observedRegression: string;
  suspectedCause: string;
  proposedAdjustment: string;
  expectedBenefit: number;
  expectedRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  evidenceReferences: string[];
  rollbackPlan: string;
  validationPlan: string;
  tenantId: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createAdaptationProposal(
  input: Omit<AdaptationProposal, 'proposalId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): AdaptationProposal {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.strategyId}:${input.correlationId}`;
  return {
    proposalId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
