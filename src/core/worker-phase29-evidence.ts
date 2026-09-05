import { randomUUID } from 'crypto';

export interface DataEvidence {
  evidenceId: string;
  operationId: string;
  resourceId: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createDataEvidence(input: Omit<DataEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }): DataEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.operationId}:${input.type}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
