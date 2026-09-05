import { randomUUID } from 'crypto';

export interface SecurityEvidence {
  evidenceId: string;
  tenantId: string;
  correlationId: string;
  actionId: string;
  evidenceType: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createSecurityEvidence(
  input: Omit<SecurityEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): SecurityEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.actionId}:${input.evidenceType}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
