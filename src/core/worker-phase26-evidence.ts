import { randomUUID } from 'crypto';

export interface OperationalEvidence {
  evidenceId: string;
  operation: string;
  actor: string;
  timestamp: string;
  inputs: Record<string, unknown>;
  decision: string;
  executionResult: string;
  verificationResult: string;
  provenance: string;
  idempotencyKey: string;
}

export function createOperationalEvidence(
  input: Omit<OperationalEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): OperationalEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.operation}:${input.provenance}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
