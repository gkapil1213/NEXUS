import { randomUUID } from 'crypto';

export interface OptimizationHypothesis {
  hypothesisId: string;
  tenantId: string;
  workerFleetId: string;
  sourcePolicyVersion: string;
  sourceEvolutionProposal?: string;
  objective: string;
  baselineMetrics: Record<string, number>;
  expectedImprovement: Record<string, number>;
  maximumAcceptableRegression: Record<string, number>;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidenceRequirement: 'HIGH' | 'MEDIUM' | 'LOW';
  experimentScope: 'FLEET' | 'WORKER' | 'SERVICE';
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createOptimizationHypothesis(
  input: Omit<OptimizationHypothesis, 'hypothesisId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationHypothesis {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.workerFleetId}:${input.sourcePolicyVersion}:${input.objective}`;
  return {
    hypothesisId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
