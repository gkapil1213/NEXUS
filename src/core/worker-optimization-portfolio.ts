import { randomUUID } from 'crypto';

export type PortfolioState = 'DRAFT' | 'READY' | 'ACTIVE' | 'PAUSED' | 'FROZEN' | 'COMPLETED' | 'ABORTED';

export interface OptimizationPortfolio {
  portfolioId: string;
  tenantId: string;
  objectiveSet: string[];
  candidates: string[];
  experiments: string[];
  policyVersions: string[];
  state: PortfolioState;
  priority: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  expectedBenefit: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  resourceRequirements: Record<string, number>;
  dependencies: string[];
  conflicts: string[];
  createdAt: string;
  lastEvaluatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createOptimizationPortfolio(
  input: Omit<OptimizationPortfolio, 'portfolioId' | 'createdAt' | 'lastEvaluatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationPortfolio {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.correlationId}`;
  return {
    portfolioId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    lastEvaluatedAt: new Date().toISOString(),
    idempotencyKey,
  };
}
