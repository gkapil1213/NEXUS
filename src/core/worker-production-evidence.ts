import { randomUUID } from 'crypto';

export interface ProductionEvidence {
  evidenceId: string;
  tenantId: string;
  correlationId: string;
  operationId: string;
  evidenceType: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createProductionEvidence(
  input: Omit<ProductionEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): ProductionEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.operationId}:${input.evidenceType}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
