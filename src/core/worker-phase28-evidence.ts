import { randomUUID } from 'crypto';

export interface InfrastructureEvidence {
  evidenceId: string;
  resourceId: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createInfrastructureEvidence(input: Omit<InfrastructureEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }): InfrastructureEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.resourceId}:${input.type}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
