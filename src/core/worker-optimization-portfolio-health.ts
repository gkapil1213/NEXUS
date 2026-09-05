export type PortfolioHealth = 'HEALTHY' | 'DEGRADED' | 'UNSTABLE' | 'STAGNANT' | 'UNSAFE';

export interface PortfolioHealthInput {
  populationHealth: number; // 0-1
  experimentHealth: number; // 0-1
  confidence: number;
  regressionRate: number;
  risk: number;
  diversity: number;
  redundancy: number;
  resourceUtilization: number;
  stagnation: number;
  failureRate: number;
}

export function evaluatePortfolioHealth(input: PortfolioHealthInput): PortfolioHealth {
  if (input.risk > 0.8 || input.resourceUtilization > 0.9 || input.failureRate > 0.7) return 'UNSAFE';
  if (input.regressionRate > 0.5 || input.redundancy > 0.7) return 'DEGRADED';
  if (input.stagnation > 0.7) return 'STAGNANT';
  if (input.populationHealth < 0.3 || input.experimentHealth < 0.3 || input.diversity < 0.2) return 'UNSTABLE';
  if (input.confidence < 0.3) return 'DEGRADED';
  return 'HEALTHY';
}
