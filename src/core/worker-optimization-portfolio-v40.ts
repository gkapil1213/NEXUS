import { randomUUID } from 'crypto';

export type PortfolioStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'DEGRADED' | 'RECOVERING' | 'RETIRED';

export interface OptimizationPortfolioV40 {
  portfolioId: string;
  tenantId: string;
  objective: string;
  ownerContext: string;
  includedPopulations: string[];
  resourceBudget: number;
  riskBudget: number;
  experimentLimits: number;
  governancePolicy: string;
  safetyPolicy: string;
  status: PortfolioStatus;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createOptimizationPortfolioV40(
  input: Omit<OptimizationPortfolioV40, 'portfolioId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationPortfolioV40 {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.objective}:${input.includedPopulations.join(',')}`;
  const now = new Date().toISOString();
  return {
    portfolioId: randomUUID(),
    ...input,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function validatePortfolioV40(portfolio: OptimizationPortfolioV40): { valid: boolean; reason: string } {
  if (!portfolio.objective || !portfolio.ownerContext) return { valid: false, reason: 'missing objective/owner' };
  if (portfolio.includedPopulations.length === 0) return { valid: false, reason: 'no populations' };
  if (portfolio.resourceBudget <= 0 || portfolio.riskBudget <= 0 || portfolio.experimentLimits <= 0) return { valid: false, reason: 'invalid budgets/limits' };
  return { valid: true, reason: 'OK' };
}

export function attachPopulationV40(portfolio: OptimizationPortfolioV40, populationId: string): OptimizationPortfolioV40 {
  if (portfolio.includedPopulations.includes(populationId)) {
    throw new Error(`Population ${populationId} already attached`);
  }
  return { ...portfolio, includedPopulations: [...portfolio.includedPopulations, populationId], updatedAt: new Date().toISOString() };
}
