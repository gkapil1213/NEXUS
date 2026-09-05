export interface FinOpsSummary {
  resourceId: string;
  currentCost: number;
  projectedCost: number;
  budget: number;
  idle: boolean;
  underutilized: boolean;
  overprovisioned: boolean;
  state: 'HEALTHY' | 'AT_RISK' | 'BREACHED';
}

export function evaluateFinOps(input: { currentCost: number; projectedCost: number; budget: number; utilization: number }): FinOpsSummary {
  const state = input.projectedCost >= input.budget ? 'BREACHED' : input.projectedCost >= input.budget * 0.8 ? 'AT_RISK' : 'HEALTHY';
  return {
    resourceId: 'unknown',
    currentCost: input.currentCost,
    projectedCost: input.projectedCost,
    budget: input.budget,
    idle: input.utilization < 0.05,
    underutilized: input.utilization < 0.2,
    overprovisioned: input.utilization < 0.5,
    state,
  };
}
