import { randomUUID } from 'crypto';

export interface StrategyCandidate {
  candidateId: string;
  strategyId: string;
  tenantId: string;
  objectiveImpacts: Record<string, number>;
  expectedBenefit: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  evidenceRefs: string[];
  resourceRequirements: Record<string, number>;
  interactionEffects: Record<string, number>;
  status: 'PROPOSED' | 'SCORED' | 'PARETO_SELECTED' | 'DOMINATED' | 'REJECTED';
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createStrategyCandidate(
  input: Omit<StrategyCandidate, 'candidateId' | 'createdAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): StrategyCandidate {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.strategyId}:${input.correlationId}`;
  return {
    candidateId: randomUUID(),
    ...input,
    status: 'PROPOSED',
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
