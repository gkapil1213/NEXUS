import { randomUUID } from 'crypto';

export interface RuntimeEvidence {
  evidenceId: string;
  serviceId: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createRuntimeEvidence(input: Omit<RuntimeEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }): RuntimeEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.serviceId}:${input.type}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
