export interface ExecutionBudget {
  portfolioId: string;
  totalBudget: number;
  reserved: number;
  consumed: number;
  updatedAt: string;
}

export function createExecutionBudget(portfolioId: string, totalBudget: number): ExecutionBudget {
  return { portfolioId, totalBudget, reserved: 0, consumed: 0, updatedAt: new Date().toISOString() };
}

export function reserveBudget(budget: ExecutionBudget, amount: number): { budget: ExecutionBudget; success: boolean; reason: string } {
  const newReserved = budget.reserved + amount;
  if (newReserved > budget.totalBudget) return { budget, success: false, reason: 'overrun' };
  return { budget: { ...budget, reserved: newReserved, updatedAt: new Date().toISOString() }, success: true, reason: 'OK' };
}

export function consumeBudget(budget: ExecutionBudget, amount: number): { budget: ExecutionBudget; success: boolean; reason: string } {
  if (amount > budget.reserved) return { budget, success: false, reason: 'insufficient reserved' };
  const newConsumed = budget.consumed + amount;
  if (newConsumed > budget.totalBudget) return { budget, success: false, reason: 'overrun' };
  return { budget: { ...budget, reserved: budget.reserved - amount, consumed: newConsumed, updatedAt: new Date().toISOString() }, success: true, reason: 'OK' };
}
