import { randomUUID } from 'crypto';

export type ExperimentStatus = 'DRAFT' | 'VALIDATED' | 'APPROVED' | 'RUNNING' | 'EVIDENCE_COLLECTION' | 'EVALUATING' | 'DECIDED' | 'APPLIED' | 'REJECTED' | 'PAUSED' | 'FAILED' | 'ROLLED_BACK' | 'CANCELLED';

export interface PopulationExperimentDefinition {
  experimentId: string;
  populationId: string;
  populationVersion: number;
  strategyIds: string[];
  championStrategyId?: string;
  challengerStrategyId?: string;
  experimentType: string;
  hypothesis: string;
  objective: string;
  baseline: Record<string, number>;
  treatment: Record<string, number>;
  metrics: string[];
  constraints: string[];
  resourceBudget: number;
  minimumEvidence: number;
  confidenceThreshold: number;
  safetyRequirements: string[];
  governanceRequirements: string[];
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createPopulationExperimentDefinition(
  input: Omit<PopulationExperimentDefinition, 'experimentId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): PopulationExperimentDefinition {
  const idempotencyKey = input.idempotencyKey ?? `${input.populationId}:${input.populationVersion}:${input.experimentType}:${input.hypothesis}`;
  const now = new Date().toISOString();
  return {
    experimentId: randomUUID(),
    ...input,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function validateExperimentDefinition(exp: PopulationExperimentDefinition): { valid: boolean; reason: string } {
  if (!exp.strategyIds || exp.strategyIds.length === 0) return { valid: false, reason: 'no strategies' };
  if (!exp.hypothesis || !exp.objective) return { valid: false, reason: 'missing hypothesis/objective' };
  if (!exp.metrics || exp.metrics.length === 0) return { valid: false, reason: 'no metrics' };
  if (exp.resourceBudget <= 0) return { valid: false, reason: 'invalid budget' };
  if (exp.minimumEvidence <= 0 || exp.confidenceThreshold < 0 || exp.confidenceThreshold > 1) return { valid: false, reason: 'invalid evidence/confidence' };
  return { valid: true, reason: 'OK' };
}
