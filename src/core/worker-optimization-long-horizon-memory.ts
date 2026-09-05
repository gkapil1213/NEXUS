import { randomUUID } from 'crypto';

export type OptimizationMemoryStatus = 'SUCCESS' | 'FAILED' | 'NEUTRAL' | 'INCONCLUSIVE' | 'REGRESSED' | 'ROLLED_BACK' | 'EXPIRED' | 'SUPERSEDED';

export interface OptimizationMemoryRecord {
  memoryId: string;
  optimizationId: string;
  portfolioId: string;
  candidateId: string;
  policyVersion: string;
  objective: string;
  baseline: Record<string, number>;
  treatment: Record<string, number>;
  observedResult: Record<string, number>;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  durationHours: number;
  environment: string;
  scope: string;
  resourceCost: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  rollbackHistory: string[];
  evidenceReferences: string[];
  causalConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  durabilityClassification?: string;
  status: OptimizationMemoryStatus;
  tenantId: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createOptimizationMemoryRecord(
  input: Omit<OptimizationMemoryRecord, 'memoryId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationMemoryRecord {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.optimizationId}:${input.candidateId}`;
  return {
    memoryId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
