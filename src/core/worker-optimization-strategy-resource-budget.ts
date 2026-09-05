export interface StrategyResourceBudget {
  tenantId: string;
  limits: Record<string, number>;
  currentUsage: Record<string, number>;
  reserved: Record<string, number>;
}

export function createStrategyResourceBudget(
  tenantId: string,
  limits: Record<string, number>,
  currentUsage: Record<string, number> = {}
): StrategyResourceBudget {
  return { tenantId, limits, currentUsage, reserved: {} };
}

export function reserveStrategyResources(
  budget: StrategyResourceBudget,
  requests: Record<string, number>
): { budget: StrategyResourceBudget; success: boolean; reason: string } {
  const newReserved = { ...budget.reserved };
  const projected = { ...budget.currentUsage };
  for (const [resource, amount] of Object.entries(requests)) {
    const limit = budget.limits[resource];
    if (limit === undefined) return { budget, success: false, reason: `Unknown resource ${resource}` };
    const current = (budget.currentUsage[resource] ?? 0) + (newReserved[resource] ?? 0);
    if (current + amount > limit) {
      return { budget, success: false, reason: `Resource budget exceeded for ${resource}` };
    }
    newReserved[resource] = (newReserved[resource] ?? 0) + amount;
    projected[resource] = (projected[resource] ?? 0) + amount;
  }
  return {
    budget: { ...budget, reserved: newReserved, currentUsage: projected },
    success: true,
    reason: 'OK',
  };
}
