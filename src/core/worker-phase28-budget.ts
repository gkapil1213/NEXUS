export interface BudgetStatus {
  total: number;
  consumed: number;
  forecast: number;
  threshold: number;
  state: 'HEALTHY' | 'AT_RISK' | 'BREACHED' | 'UNKNOWN';
}

export function evaluateBudget(input: { total: number; consumed: number; forecast: number; threshold: number }): BudgetStatus {
  if (input.consumed >= input.total) return { ...input, state: 'BREACHED' };
  if (input.forecast >= input.total * input.threshold) return { ...input, state: 'AT_RISK' };
  return { ...input, state: 'HEALTHY' };
}
