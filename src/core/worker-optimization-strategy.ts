import { randomUUID } from 'crypto';

export interface OptimizationStrategy {
  strategyId: string;
  tenantId: string;
  portfolioRefs: string[];
  actions: string[];
  objectives: string[];
  expectedOutcomes: Record<string, number>;
  predictedCost: number;
  predictedReliabilityImpact: number;
  predictedRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  evidenceRefs: string[];
  interactionEffects: Record<string, number>;
  constraintResults: string[];
  governanceStatus: string;
  safetyStatus: string;
  lifecycleStatus: string;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createOptimizationStrategy(
  input: Omit<OptimizationStrategy, 'strategyId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationStrategy {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.correlationId}`;
  const now = new Date().toISOString();
  return {
    strategyId: randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}
