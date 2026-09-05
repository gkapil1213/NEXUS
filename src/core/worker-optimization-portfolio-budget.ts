export interface PortfolioBudget {
  maxExperiments: number;
  maxConcurrent: number;
  maxCompute: number;
  maxRollout: number;
  maxEvaluation: number;
}

export interface BudgetUsage {
  experiments: number;
  concurrent: number;
  compute: number;
  rollout: number;
  evaluation: number;
}

export function checkPortfolioBudget(budget: PortfolioBudget, usage: BudgetUsage): { allowed: boolean; reason: string } {
  if (usage.experiments >= budget.maxExperiments) return { allowed: false, reason: 'experiment budget exceeded' };
  if (usage.concurrent >= budget.maxConcurrent) return { allowed: false, reason: 'concurrency budget exceeded' };
  if (usage.compute >= budget.maxCompute) return { allowed: false, reason: 'compute budget exceeded' };
  if (usage.rollout >= budget.maxRollout) return { allowed: false, reason: 'rollout budget exceeded' };
  if (usage.evaluation >= budget.maxEvaluation) return { allowed: false, reason: 'evaluation budget exceeded' };
  return { allowed: true, reason: 'OK' };
}
