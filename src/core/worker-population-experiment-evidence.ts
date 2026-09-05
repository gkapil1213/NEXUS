export type EvidenceType = 'PARTIAL' | 'SUFFICIENT' | 'INSUFFICIENT' | 'CONFLICTING' | 'DURABLE' | 'TRANSIENT' | 'REGRESSION' | 'FAILURE';

export interface ExperimentEvidence {
  experimentId: string;
  strategyId: string;
  generationId: string;
  lineageId: string;
  outcome: Record<string, number>;
  confidence: number;
  evidenceLevel: EvidenceType;
  sampleSize: number;
  durability: number;
  timestamp: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createExperimentEvidence(
  input: Omit<ExperimentEvidence, 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): ExperimentEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.experimentId}:${input.strategyId}:${input.generationId}:${input.correlationId}`;
  return {
    ...input,
    timestamp: new Date().toISOString(),
    idempotencyKey,
  };
}

export function classifyEvidence(sampleSize: number, confidence: number, durability: number, regression: boolean): EvidenceType {
  if (sampleSize < 5) return 'INSUFFICIENT';
  if (regression) return 'REGRESSION';
  if (durability < 0.3) return 'TRANSIENT';
  if (durability > 0.7 && confidence > 0.7) return 'DURABLE';
  return 'PARTIAL';
}
