import { randomUUID } from 'crypto';

export interface OptimizationOpportunity {
  opportunityId: string;
  resourceId: string;
  type: string;
  reason: string;
  estimatedSavings: number;
  confidence: number;
  blastRadius: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  risk: string;
  governanceRequirement: string;
  approvalRequired: boolean;
  rollbackPossible: boolean;
  createdAt: string;
  idempotencyKey: string;
}

export function createOptimizationOpportunity(
  input: Omit<OptimizationOpportunity, 'opportunityId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationOpportunity {
  const idempotencyKey = input.idempotencyKey ?? `${input.resourceId}:${input.type}:${input.reason}`;
  return { opportunityId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
