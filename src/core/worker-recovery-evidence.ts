export interface RecoveryEvidence {
  evidenceId: string;
  tenantId: string;
  correlationId: string;
  recoveryId: string;
  evidenceType: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createRecoveryEvidence(
  input: Omit<RecoveryEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): RecoveryEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.recoveryId}:${input.evidenceType}`;
  return { evidenceId: `ev-${Date.now()}`, ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
