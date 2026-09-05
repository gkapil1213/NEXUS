import { randomUUID } from 'crypto';

export type GenerationStatus = 'DRAFT' | 'PROPOSED' | 'VALIDATING' | 'SHADOW' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'ROLLOUT' | 'ACTIVE' | 'ROLLED_BACK' | 'RETIRED';

export interface StrategyGeneration {
  generationId: string;
  strategyId: string;
  parentGenerationId: string | null;
  rootStrategyId: string;
  tenantId: string;
  createdAt: string;
  sourceEvidence: string[];
  learningInputs: string[];
  mutationRationale: string;
  constraints: string[];
  expectedObjectives: Record<string, number>;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  validationStatus: string;
  governanceStatus: string;
  rolloutStatus: string;
  outcomeStatus: string;
  retirementStatus: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createStrategyGeneration(
  input: Omit<StrategyGeneration, 'generationId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): StrategyGeneration {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.strategyId}:${input.parentGenerationId ?? 'root'}:${input.correlationId}`;
  return {
    generationId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
