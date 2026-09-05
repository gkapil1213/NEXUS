import { randomUUID } from 'crypto';

export interface OptimizationOpportunity {
  opportunityId: string;
  resourceId: string;
  type: string;
  rationale: string;
  evidence: string[];
  estimatedImpact: string;
  risk: string;
  confidence: number;
  blastRadius: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recommendedAction: string;
  rollbackPlan: string;
  governanceState: string;
  executionState: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createOptimizationOpportunity(
  input: Omit<OptimizationOpportunity, 'opportunityId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationOpportunity {
  const idempotencyKey = input.idempotencyKey ?? `${input.resourceId}:${input.type}:${input.recommendedAction}`;
  return { opportunityId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
