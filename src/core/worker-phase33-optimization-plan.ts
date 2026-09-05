import { randomUUID } from 'crypto';

export interface OptimizationPlan {
  planId: string;
  opportunityId: string;
  actions: string[];
  risk: string;
  blastRadius: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createOptimizationPlan(input: Omit<OptimizationPlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): OptimizationPlan {
  const idempotencyKey = input.idempotencyKey ?? input.opportunityId;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
