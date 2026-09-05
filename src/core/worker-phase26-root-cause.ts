import { randomUUID } from 'crypto';

export interface RootCauseCandidate {
  candidateId: string;
  category: string;
  confidence: number;
  evidence: string[];
  explanation: string;
  firstObserved: string;
  lastObserved: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRootCauseCandidate(input: Omit<RootCauseCandidate, 'candidateId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): RootCauseCandidate {
  const idempotencyKey = input.idempotencyKey ?? `${input.category}:${input.explanation}`;
  return { candidateId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
