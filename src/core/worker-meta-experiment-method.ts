import { randomUUID } from 'crypto';

export type MethodStatus = 'PROPOSED' | 'SHADOW' | 'EVALUATING' | 'APPROVED' | 'ACTIVE' | 'DEGRADED' | 'FROZEN' | 'RETIRED' | 'REJECTED';

export interface ExperimentalMethod {
  methodId: string;
  version: number;
  fingerprint: string;
  parentLineageId: string | null;
  tenantId: string;
  objectives: string[];
  constraints: string[];
  expectedCost: number;
  expectedBenefit: number;
  historicalPerformance: number;
  confidence: number;
  status: MethodStatus;
  governanceState: string;
  safetyState: string;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createExperimentalMethod(
  input: Omit<ExperimentalMethod, 'methodId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): ExperimentalMethod {
  const fingerprint = input.fingerprint ?? `${input.parentLineageId ?? 'root'}:${input.objectives.join(',')}:${input.constraints.join(',')}`;
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.version}:${fingerprint}`;
  const now = new Date().toISOString();
  return {
    methodId: randomUUID(),
    ...input,
    fingerprint,
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}
