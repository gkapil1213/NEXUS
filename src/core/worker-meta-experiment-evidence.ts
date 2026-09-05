import { randomUUID } from 'crypto';

export type MetaEvidenceType = 'POSITIVE' | 'NEGATIVE' | 'CONFLICTING' | 'INSUFFICIENT' | 'DURABLE' | 'TRANSIENT';

export interface MetaExperimentEvidence {
  evidenceId: string;
  metaExperimentId: string;
  methodId: string;
  outcome: Record<string, number>;
  confidence: number;
  evidenceType: MetaEvidenceType;
  sampleSize: number;
  durability: number;
  timestamp: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createMetaEvidence(
  input: Omit<MetaExperimentEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): MetaExperimentEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.metaExperimentId}:${input.methodId}:${input.correlationId}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
