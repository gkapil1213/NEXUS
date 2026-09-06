import { randomUUID } from 'crypto';
export function processRemediationRollback(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return { id, idempotencyKey: input.idempotencyKey || id, executionId: input.executionId, reason: input.reason || null, status: input.fail ? 'failed' : 'success', verificationResult: input.verificationResult || 'success' };
}
