import { randomUUID } from 'crypto';

export interface StrategyEvolutionCandidate {
  candidateId: string;
  parentStrategyId: string;
  parentGenerationId: string;
  proposedGeneration: number;
  tenantId: string;
  sourceEvidence: string[];
  changeSet: Record<string, { before: unknown; after: unknown }>;
  expectedBenefits: Record<string, number>;
  expectedRisks: Record<string, number>;
  constraints: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  reason: string;
  correlationId: string;
  createdAt: string;
  fingerprint: string;
  idempotencyKey: string;
}

export function createEvolutionCandidate(
  input: Omit<StrategyEvolutionCandidate, 'candidateId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): StrategyEvolutionCandidate {
  const fingerprint = computeFingerprint(input.parentGenerationId, input.changeSet, input.expectedBenefits);
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.parentStrategyId}:${fingerprint}`;
  return {
    candidateId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    fingerprint,
    idempotencyKey,
  };
}

function computeFingerprint(parentGenerationId: string, changeSet: Record<string, { before: unknown; after: unknown }>, benefits: Record<string, number>): string {
  const changeStr = JSON.stringify(changeSet);
  const benefitStr = JSON.stringify(benefits);
  return `${parentGenerationId}:${changeStr}:${benefitStr}`;
}
