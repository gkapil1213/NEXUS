export type ResourceState = 'AVAILABLE' | 'RESERVED' | 'CONSUMED' | 'RELEASED' | 'OVERCOMMITTED';

export interface ResourceBudget {
  tenantId: string;
  limits: Record<string, number>;
  reserved: Record<string, number>;
  consumed: Record<string, number>;
}

export function createResourceBudget(tenantId: string, limits: Record<string, number>): ResourceBudget {
  return { tenantId, limits, reserved: {}, consumed: {} };
}

export function reserveResource(budget: ResourceBudget, resource: string, amount: number): { budget: ResourceBudget; success: boolean; reason: string } {
  const currentReserved = budget.reserved[resource] ?? 0;
  const currentConsumed = budget.consumed[resource] ?? 0;
  const limit = budget.limits[resource];
  if (limit === undefined) return { budget, success: false, reason: `Unknown resource ${resource}` };
  const total = currentReserved + currentConsumed + amount;
  if (total > limit) return { budget, success: false, reason: `Overcommitment for ${resource}` };
  const newReserved = { ...budget.reserved, [resource]: currentReserved + amount };
  return { budget: { ...budget, reserved: newReserved }, success: true, reason: 'OK' };
}

export function releaseResource(budget: ResourceBudget, resource: string, amount: number): ResourceBudget {
  const current = budget.reserved[resource] ?? 0;
  const newValue = Math.max(0, current - amount);
  return { ...budget, reserved: { ...budget.reserved, [resource]: newValue } };
}
