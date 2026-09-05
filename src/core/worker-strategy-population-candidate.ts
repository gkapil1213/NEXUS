import { randomUUID } from 'crypto';

export interface PopulationCandidate {
  candidateId: string;
  tenantId: string;
  strategyId: string;
  generationId: string;
  lineageId: string;
  fingerprint: string;
  objectiveProfile: Record<string, number>;
  behavioralDimensions: Record<string, number>;
  resourceProfile: Record<string, number>;
  failurePatterns: string[];
  status: 'ELIGIBLE' | 'DUPLICATE' | 'REDUNDANT' | 'REJECTED';
  reason?: string;
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createPopulationCandidate(
  input: Omit<PopulationCandidate, 'candidateId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): PopulationCandidate {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.strategyId}:${input.generationId}`;
  return { candidateId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
