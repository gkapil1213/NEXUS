export interface ExperimentOutcome {
  experimentId: string;
  strategyId: string;
  generationId: string;
  lineageId: string;
  populationId: string;
  populationVersion: number;
  objective: string;
  metric: string;
  baseline: number;
  treatment: number;
  attributionConfidence: number;
  evidenceLevel: string;
  outcome: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'INCONCLUSIVE';
  timestamp: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createExperimentOutcome(
  input: Omit<ExperimentOutcome, 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): ExperimentOutcome {
  const idempotencyKey = input.idempotencyKey ?? `${input.experimentId}:${input.strategyId}:${input.metric}:${input.correlationId}`;
  return { ...input, timestamp: new Date().toISOString(), idempotencyKey };
}

export function attributeExperimentOutcome(
  treatmentDelta: number,
  baselineVariance: number,
  confidence: number,
  concurrentChanges: boolean
): { attributionConfidence: number; attributability: boolean } {
  if (concurrentChanges) return { attributionConfidence: 0.2, attributability: false };
  if (confidence < 0.5) return { attributionConfidence: 0.3, attributability: false };
  const conf = Math.min(1, confidence * (1 - baselineVariance));
  return { attributionConfidence: conf, attributability: conf >= 0.5 };
}
