export interface ExperimentBudgetState {
  executionBudget: number;
  computeBudget: number;
  timeBudget: number;
  experimentCountBudget: number;
  mutationBudget: number;
  rolloutBudget: number;
  rollbackBudget: number;
}

export interface BudgetCheckInput {
  budget: ExperimentBudgetState;
  requested: Partial<ExperimentBudgetState>;
  safetyHealthy: boolean;
  governanceAllowed: boolean;
  populationStable: boolean;
}

export function evaluateExperimentBudget(input: BudgetCheckInput): { allowed: boolean; reason: string } {
  if (!input.safetyHealthy) return { allowed: false, reason: 'safety unhealthy' };
  if (!input.governanceAllowed) return { allowed: false, reason: 'governance blocked' };
  if (!input.populationStable) return { allowed: false, reason: 'population unstable' };
  for (const key of Object.keys(input.requested) as (keyof ExperimentBudgetState)[]) {
    const available = input.budget[key] ?? 0;
    const needed = input.requested[key] ?? 0;
    if (needed > available) {
      return { allowed: false, reason: `budget exceeded for ${key}` };
    }
  }
  return { allowed: true, reason: 'OK' };
}

export function consumeBudget(budget: ExperimentBudgetState, usage: Partial<ExperimentBudgetState>): ExperimentBudgetState {
  const result = { ...budget };
  for (const key of Object.keys(usage) as (keyof ExperimentBudgetState)[]) {
    result[key] = Math.max(0, (result[key] ?? 0) - (usage[key] ?? 0));
  }
  return result;
}
