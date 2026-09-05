import { randomUUID } from 'crypto';

export type MetaExperimentStatus = 'DRAFT' | 'VALIDATED' | 'APPROVED' | 'RUNNING' | 'EVIDENCE_COLLECTION' | 'EVALUATING' | 'DECIDED' | 'APPLIED' | 'REJECTED' | 'PAUSED' | 'FAILED' | 'ROLLED_BACK' | 'CANCELLED';

export interface MetaExperimentDefinition {
  metaExperimentId: string;
  tenantId: string;
  objectiveId: string;
  methodIds: string[];
  hypothesis: string;
  constraints: string[];
  budget: number;
  minimumEvidence: number;
  confidenceThreshold: number;
  status: MetaExperimentStatus;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createMetaExperimentDefinition(
  input: Omit<MetaExperimentDefinition, 'metaExperimentId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): MetaExperimentDefinition {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.objectiveId}:${input.methodIds.join(',')}:${input.hypothesis}`;
  const now = new Date().toISOString();
  return {
    metaExperimentId: randomUUID(),
    ...input,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function validateMetaExperimentDefinition(def: MetaExperimentDefinition): { valid: boolean; reason: string } {
  if (!def.methodIds || def.methodIds.length < 2) return { valid: false, reason: 'at least two methods required' };
  if (!def.hypothesis || !def.objectiveId) return { valid: false, reason: 'missing hypothesis/objective' };
  if (def.budget <= 0 || def.minimumEvidence <= 0 || def.confidenceThreshold < 0 || def.confidenceThreshold > 1) return { valid: false, reason: 'invalid budget/evidence/confidence' };
  return { valid: true, reason: 'OK' };
}
