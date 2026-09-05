import { randomUUID } from 'crypto';

export interface Evidence {
  evidenceId: string;
  identityId: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createEvidence(input: Omit<Evidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }): Evidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.identityId}:${input.type}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
