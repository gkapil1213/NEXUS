export interface Budget {
  budgetId: string;
  name: string;
  amount: number;
  consumed: number;
  forecast: number;
  threshold: number;
  state: 'HEALTHY' | 'AT_RISK' | 'BREACHED';
}

export function evaluateBudget(input: { amount: number; consumed: number; forecast: number; threshold: number }): Budget {
  const budget: Budget = {
    budgetId: `budget-${Date.now()}`,
    name: 'default',
    amount: input.amount,
    consumed: input.consumed,
    forecast: input.forecast,
    threshold: input.threshold,
    state: 'HEALTHY',
  };
  if (input.consumed >= input.amount) budget.state = 'BREACHED';
  else if (input.forecast >= input.amount * input.threshold) budget.state = 'AT_RISK';
  return budget;
}
