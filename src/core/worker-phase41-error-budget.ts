import { randomUUID } from 'crypto';
export function processErrorBudget(input: any): any {
  const budgetAmount = input.budgetAmount || 100;
  const consumedAmount = input.consumedAmount || 0;
  const remainingAmount = budgetAmount - consumedAmount;
  const burnRate = input.burnRate || 0;
  let exhaustionPrediction = null;
  if (burnRate > 0) exhaustionPrediction = new Date(Date.now() + (remainingAmount / burnRate) * 3600000).toISOString();
  return {
    id: input.idempotencyKey || randomUUID(),
    sloId: input.sloId,
    budgetAmount,
    consumedAmount,
    remainingAmount,
    burnRate,
    exhaustionPrediction,
  };
}
