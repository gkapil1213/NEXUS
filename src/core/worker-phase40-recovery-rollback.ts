import { randomUUID } from 'crypto';
export function processRecoveryRollback(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    incidentId: input.incidentId,
    executionId: input.executionId || null,
    reason: input.reason || null,
    status: input.fail ? 'failed' : 'success',
    verificationResult: input.verificationResult || 'success',
  };
}
