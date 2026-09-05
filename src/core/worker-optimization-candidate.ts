import { randomUUID } from 'crypto';

export interface OptimizationCandidate {
  candidateId: string;
  source: string;
  sourceVersion: string;
  objectiveImpact: Record<string, number>;
  expectedBenefit: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  requiredEvidence: string[];
  dependencies: string[];
  conflicts: string[];
  rollbackPlan: string;
  tenantId: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createOptimizationCandidate(
  input: Omit<OptimizationCandidate, 'candidateId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationCandidate {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.source}:${input.sourceVersion}:${input.correlationId}`;
  return {
    candidateId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
